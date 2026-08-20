// ──────────────────────────────────────────────────────────────────────────
// The gate — framework-agnostic decision function.
//
// One call in, one decision out, no I/O beyond the JWKS cache and the quota
// store. Everything framework-shaped lives in ./express.ts (or in the ~15
// lines it takes to adapt this to Fastify, Hono or a Worker), which is also
// why the whole decision path is unit-testable without a server.
//
// The order below reproduces backend/aifp/gate.js, minus the branches that are
// ours and not the merchant's. See "What this does NOT do" in the README:
// free-unit allowances, daily caps and per-agent blocks stay in the hosted
// control plane on purpose. A partner-side reimplementation of a policy the
// merchant edits in our dashboard would be a second source of truth for the
// same rule, and the two would disagree on the day it mattered.
// ──────────────────────────────────────────────────────────────────────────
import type {
  AifpContext,
  AifpResource,
  GateEvent,
  GateRequest,
  GateResult,
  Tier,
} from "./types.js";
import { MemoryStore } from "./stores/memory.js";
import type { GateStore } from "./stores/types.js";
import { createVerifier } from "./verify.js";
import { buildChallenge } from "./challenge.js";
import { scopeCovers } from "./scope.js";
import { weightForTier } from "./pricing.js";
import type { ResourceRegistry } from "./registry.js";

export interface GateOptions {
  /** "mrch_…" — must equal the receipt's `aud`, which is what stops a receipt
   *  bought for one merchant being spent at another. */
  merchantId: string;
  /** Static mount. Omit when using `registry`. */
  resource?: string;
  tier?: Tier;
  /** Billing units per call. Defaults to the tier preset; a registry record's
   *  `unit_weight` wins over both. */
  weight?: number;
  store?: GateStore;
  issuer?: string;
  jwksUri?: string;
  /** Pin the key set; skips all network I/O. */
  jwks?: { keys: object[] };
  keyPrefix?: string;
  clockToleranceSec?: number;
  /** Path-matched mode: charge whatever the merchant registered for the path. */
  registry?: ResourceRegistry;
  /** Origin serving /v1/quote and /v1/pay, emitted in the 402. Default
   *  https://api.aifinpay.io. This gate runs on YOUR host, so the challenge has
   *  to name an absolute AiFinPay URL — a relative path would send the agent
   *  looking for a quote endpoint on your own server. */
  apiBase?: string;
  /** What to do while the registry has NEVER loaded (control plane unreachable,
   *  API key rotated). Default "error" answers 503 rather than guessing a price:
   *  metering a premium route at the standard weight bills a tenth of it. Set
   *  "mount-default" to keep serving and accept the mis-pricing. Once one fetch
   *  has succeeded the last good snapshot is used and this no longer applies. */
  registryUnavailable?: "error" | "mount-default";
  /** "auto" (default) gives single-use receipts (unit_quota <= 1) a one-shot
   *  nonce check. Multi-use batches are metered by the counter and need no
   *  replay check — spending them twice is just spending them. */
  replay?: "auto" | "always" | "off";
  /** Compare the self-declared AIFP-Agent-Id header to the receipt `sub`.
   *  Anti-accident, not anti-theft: the header is not authenticated. */
  requireAgentMatch?: boolean;
  /** Give a unit back when your handler fails. Off by default — see README. */
  refundOnError?: boolean;
  /** What to do when the quota store rejects. Default "closed" → 503. */
  onStoreError?: "closed" | "open";
  /** Observability hook. Never allowed to throw into the request. */
  onEvent?: (e: GateEvent) => void;
  /** Last-word veto, evaluated after the receipt is verified and before any
   *  unit is metered — so a refused call costs the agent nothing. Use it for
   *  your own business rules (an abuse list, a maintenance window). Returning
   *  false answers 403. */
  allow?: (ctx: {
    path: string;
    resource: string;
    weight: number;
    agent: string | null;
    receipt_id: string | null;
  }) => boolean | Promise<boolean>;
}

const DEFAULT_ISSUER = "https://api.aifinpay.io";
const DEFAULT_JWKS = "https://api.aifinpay.io/.well-known/jwks.json";

/** Sentences the hosted gate answers with. Duplicated here as constants and
 *  asserted against the server's source in tests/contract-parity.test.ts —
 *  a self-hosted gate that phrases a refusal differently than the hosted one
 *  is a support ticket per integration. */
export const DETAIL_QUOTA_EXHAUSTED = "quota exhausted — prepay the next batch";
export const DETAIL_RECEIPT_EXPIRED = "receipt expired — prepay a new batch";
export const DETAIL_VERIFY_FAILED = "receipt verification failed (signature/issuer/audience)";
export const HEADER_QUOTA_REMAINING = "AIFP-Quota-Remaining";

export function createGate(options: GateOptions): (req: GateRequest) => Promise<GateResult> {
  const merchantId = options.merchantId;
  if (!merchantId) throw new Error("createGate: merchantId is required");

  const tier: Tier = options.tier ?? "standard";
  const mountWeight =
    Number.isInteger(options.weight) && (options.weight as number) > 0
      ? (options.weight as number)
      : weightForTier(tier);
  const keyPrefix = options.keyPrefix ?? "aifp:";
  const replayMode = options.replay ?? "auto";
  const onStoreError = options.onStoreError ?? "closed";
  const store = options.store ?? new MemoryStore({ warnIfDefaulted: true });

  const verify = createVerifier({
    issuer: options.issuer ?? DEFAULT_ISSUER,
    audience: merchantId,
    clockToleranceSec: options.clockToleranceSec ?? 30,
    jwksUri: options.jwksUri ?? DEFAULT_JWKS,
    jwks: options.jwks,
  });

  const emit = (e: GateEvent) => {
    // A partner's metrics call must not be able to fail a paid request.
    try {
      options.onEvent?.(e);
    } catch {
      /* observability is never load-bearing */
    }
  };

  // `effectiveTier` is passed in per request, never taken from the closure. In
  // registry mode the weight comes from the MATCHED resource while the tier used
  // to come from the mount, so a premium route quoted unit_price_usd $0.0005 and
  // then metered 10 units — the agent was told one price and charged another.
  // Whatever tier is advertised here must be the one `weight` was derived from.
  const challenge = (
    resource: string,
    weight: number,
    effectiveTier: Tier,
    detail?: string,
  ): GateResult => {
    emit({ kind: "402", resource, weight, detail });
    return {
      ok: false,
      status: 402,
      headers: { "Content-Type": "application/json" },
      body: buildChallenge({
        merchantId,
        resource,
        tier: effectiveTier,
        weight,
        detail,
        apiBase: options.apiBase,
      }),
    };
  };

  const forbid = (resource: string, weight: number, detail: string): GateResult => {
    emit({ kind: "403", resource, weight, detail });
    return {
      ok: false,
      status: 403,
      headers: { "Content-Type": "application/json" },
      body: { error: "AIFP-403", detail },
    };
  };

  return async function gate(req: GateRequest): Promise<GateResult> {
    const path = req.path;

    // ── 1. What is this path, and what does it cost? ──────────────────────
    let matched: AifpResource | null = null;
    if (options.registry) {
      // "Never loaded" is not "no endpoints". Until the first successful fetch
      // we do not know what anything on this API costs, and falling through to
      // the mount default silently meters a premium route at 1 unit — a tenth
      // of its price — for as long as the control plane stays unreachable.
      // Refusing to price is the honest answer; a partner who prefers
      // availability over correct billing can opt in explicitly.
      if (options.registry.neverLoaded && options.registryUnavailable !== "mount-default") {
        emit({ kind: "pricing_unavailable", resource: path, weight: 0, detail: "registry never loaded" });
        return {
          ok: false,
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
          body: {
            error: "AIFP-503-PRICING",
            detail:
              "pricing unavailable — this gate has not been able to reach the AiFinPay control plane yet",
          },
        };
      }
      matched = options.registry.match(path);
    }

    const resource = matched ? matched.route_pattern : options.resource ?? path;
    // One source of truth for "what does this call cost": the tier the weight
    // is derived from is the tier the 402 advertises.
    const effectiveTier: Tier = matched ? ((matched.tier as Tier) ?? tier) : tier;
    const weight = matched
      ? matched.unit_weight ?? weightForTier(effectiveTier)
      : mountWeight;

    // The scope test runs against the request PATH, not the route pattern —
    // an agent's receipt names a real path, and "/api/lookup/*" is not one.
    // In static-mount mode the declared resource is the path the merchant
    // published, which is what the receipt was quoted for, so it wins over
    // req.path (which a mounted router may have already stripped a prefix off).
    const scopePath = options.registry ? path : options.resource ?? path;

    const agentHeader = req.header("AIFP-Agent-Id") ?? null;

    // ── 2. Explicitly free resources ──────────────────────────────────────
    // paywall_enabled:false is the merchant saying "serve this to anyone". No
    // metering and no free-allowance spend: a free route must not quietly eat
    // an agent's prepaid units either.
    if (matched && matched.paywall_enabled === false) {
      if (options.allow && !(await safeAllow(options.allow, { path, resource, weight, agent: agentHeader, receipt_id: null }))) {
        return forbid(resource, weight, "blocked by merchant policy");
      }
      emit({ kind: "serve", resource, weight, agent: agentHeader });
      return {
        ok: true,
        status: 200,
        headers: { "AIFP-Paywall": "off" },
        aifp: {
          agent: agentHeader,
          receipt_id: "",
          resource,
          weight: 0,
          unit_quota: 0,
          used: 0,
          remaining: 0,
          mode: "open",
        },
      };
    }

    // ── 3. No receipt → the 402 that teaches an agent how to pay ──────────
    const token = req.header("AIFP-Receipt");
    if (!token) return challenge(resource, weight, effectiveTier);

    // ── 4. Verify locally ─────────────────────────────────────────────────
    const v = await verify(token);
    if (!v.ok) {
      if (v.kind === "expired") return challenge(resource, weight, effectiveTier, DETAIL_RECEIPT_EXPIRED);
      if (v.kind === "jwks_unavailable") {
        // Fail CLOSED. Failing open would turn a partner's paid API into a free
        // one for the length of our outage, which is a worse failure than a
        // 503 the agent will retry.
        emit({ kind: "meter_error", resource, weight, detail: v.reason });
        return {
          ok: false,
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
          body: {
            error: "AIFP-503-METER",
            detail: "receipt verification is temporarily unavailable — retry shortly",
          },
        };
      }
      return forbid(resource, weight, DETAIL_VERIFY_FAILED);
    }
    const payload = v.payload;

    // ── 5. Receipt TYPE — a valid signature is not a licence to spend ─────
    // The issuer signs more than one kind of token with this key AND this
    // audience. A quota receipt buys calls. A per-action billing receipt
    // (`typ_aifp: "action"`, backend/aifp/receipts.js signActionReceipt) is the
    // opposite: proof that a call was already served and already charged. Both
    // verify here, because verification answers "did we sign this", not "what
    // is it for".
    //
    // Spent unguarded, an action receipt is served free. It carries no `quota`,
    // so `limit` falls back to 1; no `scope`, which degrades to "exact" and
    // matches its own `resource`; and no `receipt_id`, so the meter counts it at
    // `used:undefined` — one counter shared by every agent presenting one, keyed
    // on a value no real receipt can ever own. It is also long-lived (30d) and
    // handed to the agent on every single call, so an agent accumulates a
    // drawer full of them just by paying normally.
    //
    // Checked as an allow-list, not a deny-list: a token kind added to the
    // issuer later must be refused by a gate compiled today, not accepted by it.
    if (payload.typ_aifp != null && payload.typ_aifp !== "quota") {
      return forbid(
        resource,
        weight,
        `receipt type "${payload.typ_aifp}" is not spendable — this endpoint needs a quota receipt`,
      );
    }
    // Belt and braces for the same class: any future token that reaches here
    // without the meter's key must be refused rather than metered at
    // `used:undefined`. The meter has exactly one id and this is it.
    if (typeof payload.receipt_id !== "string" || payload.receipt_id === "") {
      return forbid(resource, weight, "receipt carries no receipt_id and cannot be metered");
    }

    // ── 6. Scope ──────────────────────────────────────────────────────────
    if (!scopeCovers(payload.scope, payload.resource, scopePath)) {
      return forbid(
        resource,
        weight,
        `receipt is scoped to ${payload.resource} (${payload.scope || "exact"}), not ${scopePath}`,
      );
    }

    if (
      options.requireAgentMatch &&
      agentHeader &&
      payload.sub &&
      agentHeader !== payload.sub
    ) {
      return forbid(resource, weight, "AIFP-Agent-Id does not match the receipt subject");
    }

    if (
      options.allow &&
      !(await safeAllow(options.allow, {
        path,
        resource,
        weight,
        agent: payload.sub ?? null,
        receipt_id: payload.receipt_id,
      }))
    ) {
      return forbid(resource, weight, "blocked by merchant policy");
    }

    // ── 6/7. Meter ────────────────────────────────────────────────────────
    // Limit is the receipt's unit_quota; legacy receipts carry a request
    // `quota` instead, which converts at the tier weight it was priced for.
    const limit = Number(
      payload.unit_quota != null
        ? payload.unit_quota
        : (Number(payload.quota) || 1) * weightForTier(payload.tier),
    );
    // The counter must die with the receipt: never longer (a stale counter
    // refuses paid calls), never shorter (an expired counter makes the whole
    // batch spendable again).
    const ttlMs = Math.max(1000, payload.exp * 1000 - Date.now());

    // A single-use receipt has no counter headroom to protect it, so replay is
    // checked explicitly. A multi-use batch does not need it: replaying it just
    // spends it, which is what it is for.
    const wantsReplayCheck =
      replayMode === "always" || (replayMode === "auto" && limit <= 1);
    if (wantsReplayCheck) {
      // No nonce means no way to tell a first spend from a replay. Keying on
      // `undefined` would not fail open, it would fail WEIRD: every nonce-less
      // receipt in the process shares one counter, so the first is served and
      // the rest are refused as "already spent" — a receipt rejected because a
      // different agent's receipt was also malformed.
      if (typeof payload.nonce !== "string" || payload.nonce === "") {
        return forbid(resource, weight, "single-use receipt carries no nonce");
      }
      let seen: number;
      try {
        seen = await store.incrBy(`${keyPrefix}nonce:${payload.nonce}`, 1, ttlMs);
      } catch (e) {
        return storeFailure(e);
      }
      if (seen > 1) return forbid(resource, weight, "receipt already spent (single-use)");
    }

    let used: number;
    try {
      used = await store.incrBy(`${keyPrefix}used:${payload.receipt_id}`, weight, ttlMs);
    } catch (e) {
      return storeFailure(e);
    }

    // Post-increment compare: whichever concurrent request receives the value
    // that crosses the limit is the one refused, exactly once. Reading first
    // and deciding second is how a batch gets overspent.
    if (used > limit) return challenge(resource, weight, effectiveTier, DETAIL_QUOTA_EXHAUSTED);

    emit({ kind: "serve", resource, weight, agent: payload.sub, receipt_id: payload.receipt_id });
    const aifp: AifpContext = {
      agent: payload.sub ?? null,
      receipt_id: payload.receipt_id,
      resource,
      weight,
      unit_quota: limit,
      used,
      remaining: limit - used,
      mode: "paid",
    };
    return {
      ok: true,
      status: 200,
      headers: { [HEADER_QUOTA_REMAINING]: String(limit - used) },
      aifp,
    };

    function storeFailure(e: unknown): GateResult {
      const detail = e instanceof Error ? e.message : String(e);
      emit({ kind: "meter_error", resource, weight, detail });
      if (onStoreError === "open") {
        // Explicitly chosen availability over metering. The call is served and
        // NOT counted; the units it should have cost are simply not collected.
        return {
          ok: true,
          status: 200,
          headers: { "AIFP-Meter": "degraded" },
          aifp: {
            agent: payload.sub ?? null,
            receipt_id: payload.receipt_id,
            resource,
            weight,
            unit_quota: limit,
            used: 0,
            remaining: limit,
            mode: "paid",
          },
        };
      }
      return {
        ok: false,
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
        body: { error: "AIFP-503-METER", detail: "quota store unavailable — retry shortly" },
      };
    }
  };
}

/** A partner's veto must not become a 500 by throwing. A hook that blows up is
 *  treated as "no opinion" and the paid flow continues. */
async function safeAllow(
  allow: NonNullable<GateOptions["allow"]>,
  ctx: Parameters<NonNullable<GateOptions["allow"]>>[0],
): Promise<boolean> {
  try {
    return (await allow(ctx)) !== false;
  } catch {
    return true;
  }
}

/** Give back the units a call consumed after the handler failed. Exposed for
 *  refundOnError and for manual use; see the README on why this is off by
 *  default (a refund after the response has gone out is a unit served free). */
export async function refundUnits(
  store: GateStore,
  ctx: AifpContext,
  keyPrefix = "aifp:",
): Promise<void> {
  if (!store.decrBy || ctx.mode !== "paid" || ctx.weight <= 0) return;
  try {
    await store.decrBy(`${keyPrefix}used:${ctx.receipt_id}`, ctx.weight);
  } catch {
    /* best effort by contract — a failed refund must not fail the response */
  }
}
