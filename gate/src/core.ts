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
  GateMode,
  GateRequest,
  GateResult,
  OperatorPolicy,
  Tier,
} from "./types.js";
import { MemoryStore } from "./stores/memory.js";
import type { GateStore } from "./stores/types.js";
import { createVerifier } from "./verify.js";
import { buildChallenge } from "./challenge.js";
import { scopeCovers } from "./scope.js";
import { TIER_WEIGHTS, weightForTier } from "./pricing.js";
import { classifyAgent, type AgentIdentity } from "./agents.js";
import { decideOperator, type OperatorDecision } from "./operator-policy.js";
import type { ResourceRegistry } from "./registry.js";
import type { GateReporterV2, ReportingContext } from "./reporter.js";

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
  /**
   * "enforce" (the default) answers 402 / 403 / 503 as README §4 describes.
   * "shadow" makes exactly the same decision and emits exactly the same event
   * — kind, resource, weight, detail, operator, ua_class, verified — and then
   * serves the request anyway: no 402, no 403, no 503, and nothing metered
   * for a call that would have been refused. The money path is untouched, so
   * a site can watch its agent traffic in the dashboard before it charges.
   *
   * Every response from a shadow gate carries `AIFP-Mode: shadow`. One the
   * gate would have refused also carries `AIFP-Shadow-Status` (402, 403 or
   * 503) and hands your handler `req.aifp.mode === "shadow"` with the refusal
   * in `req.aifp.shadow`. A request that WOULD have been served — a valid
   * receipt, an open route, an exempt reader — is served exactly as in
   * enforce, metered and all; shadow only changes refusals.
   *
   * Omitting `mode` is enforce. An install that predates this option keeps
   * behaving as it always did; nothing flips a live paywall into shadow.
   */
  mode?: GateMode;
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
  /**
   * The merchant's per-operator access policy — allow / charge / block for
   * OpenAI, Anthropic, verified AIFP agents… — as saved on the dashboard
   * (Access rules → Operators). A gate with a `registry` reads it from the
   * public merchant view on every refresh and needs nothing here; pass the
   * object for a static install, or a function that returns the current one.
   *
   * Applied after classification and before `shouldCharge`: `allow` serves
   * free (`req.aifp.mode === "exempt"`, a `serve` event with `exempt: true`),
   * `block` answers 403 `AIFP-403` (a `403` event), `charge` is the gate's own
   * decision below. The event `detail` names the rule in enforce and shadow
   * alike. No policy, or one with no rules, leaves every decision exactly as
   * it was. See operator-policy.ts for the precedence.
   */
  operatorPolicy?: OperatorPolicy | null | (() => OperatorPolicy | null | undefined);
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
  /** Explicit v2 adapter observations; core decisions do not claim delivery.
   * Choose either the legacy producer hook or this v2 producer. */
  reporting?: {
    version: 2;
    reporter: GateReporterV2;
    /** Explicit unverified caller/consent context; never inferred from identity headers. */
    context?: (req: GateRequest) => ReportingContext;
  };
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
  /**
   * WHO pays — the content-site switch. Omitted (the default), everyone does:
   * every request on a gated route needs a receipt, which is right for an
   * API. On a page with human readers it is wrong twice over — a browser
   * cannot present a receipt and must never meet a 402 — so pass a predicate
   * and only requests it returns true for are charged; the rest are served
   * exempt, unmetered.
   *
   *   import { aifpGate, knownAiAgent } from "@aifinpay/gate";
   *   app.use("/articles", aifpGate({ merchantId, registry, shouldCharge: knownAiAgent }));
   *
   * `knownAiAgent` is the shipped default for this: self-identifying AI
   * crawlers (the population Cloudflare classifies — the ones with content
   * budgets) plus anything already speaking the AIFP protocol. See agents.ts
   * for what it deliberately does not claim to catch.
   *
   * A predicate that THROWS charges (the request proceeds as if it returned
   * true). Of the two wrong answers a broken detector can give, a 402 to one
   * human is visible and recoverable; a crawler served free is silent and
   * forever. Prefer sync, pure predicates — knownAiAgent is one — and the
   * question never arises.
   */
  shouldCharge?: (req: GateRequest) => boolean | Promise<boolean>;
}

const DEFAULT_ISSUER = "https://api.aifinpay.io";
const DEFAULT_JWKS = "https://api.aifinpay.io/.well-known/jwks.json";

/** Shared receipt failure details and response headers. The hosted gate uses
 *  merchant credit accounting while this self-hosted gate meters receipt quota. */
export const DETAIL_QUOTA_EXHAUSTED = "quota exhausted — prepay the next batch";
export const DETAIL_RECEIPT_EXPIRED = "receipt expired — prepay a new batch";
export const DETAIL_VERIFY_FAILED = "receipt verification failed (signature/issuer/audience)";
export const HEADER_QUOTA_REMAINING = "AIFP-Quota-Remaining";
/** On every response from a gate in shadow mode: `AIFP-Mode: shadow`. Enforce
 *  sends no such header — its 402 says what it is. */
export const HEADER_MODE = "AIFP-Mode";
/** On a shadow response the gate would have refused: the status it decided on. */
export const HEADER_SHADOW_STATUS = "AIFP-Shadow-Status";

export function createGate(options: GateOptions): (req: GateRequest) => Promise<GateResult> {
  const merchantId = options.merchantId;
  if (!merchantId) throw new Error("createGate: merchantId is required");
  if (options.reporting && (options.reporting.version !== 2 || options.reporting.reporter.version !== 2)) {
    throw new Error("createGate: reporting requires explicit version2 producer");
  }
  if (options.reporting && options.onEvent) {
    throw new Error("createGate: select reporting v2 or onEvent; producer dual-send is not supported");
  }

  const mode: GateMode = options.mode ?? "enforce";
  // "Shadow" with a capital, "observe", "off": a mode the gate does not know
  // must not silently become enforce (a 402 to traffic the merchant meant to
  // watch) or shadow (a paywall that stops charging).
  if (mode !== "enforce" && mode !== "shadow") {
    throw new Error(`createGate: mode must be "shadow" or "enforce": ${JSON.stringify(options.mode)}`);
  }

  const tier: Tier = options.tier ?? "standard";
  // A typo such as "Premium" would otherwise price the mount as standard: a
  // tenth of the premium price, with nothing in the response to show it.
  if (!Object.hasOwn(TIER_WEIGHTS, tier)) {
    throw new Error(`createGate: tier must be one of ${Object.keys(TIER_WEIGHTS).join(", ")}: ${JSON.stringify(tier)}`);
  }
  const mountWeight =
    Number.isInteger(options.weight) && (options.weight as number) > 0
      ? (options.weight as number)
      : weightForTier(tier);
  const keyPrefix = options.keyPrefix ?? "aifp:";
  const replayMode = options.replay ?? "auto";
  const onStoreError = options.onStoreError ?? "closed";
  const store = options.store ?? new MemoryStore({ warnIfDefaulted: true });

  const clockToleranceSec = options.clockToleranceSec ?? 30;
  const verify = createVerifier({
    issuer: options.issuer ?? DEFAULT_ISSUER,
    audience: merchantId,
    clockToleranceSec,
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

  // The operator policy in force for this request: the option when given
  // (explicitly null meaning none), else whatever the registry last read.
  const policyFor = (): OperatorPolicy | null => {
    const own = typeof options.operatorPolicy === "function" ? options.operatorPolicy() : options.operatorPolicy;
    if (own !== undefined) return own ?? null;
    const registry = options.registry as { operatorPolicy?: () => OperatorPolicy | null } | undefined;
    return typeof registry?.operatorPolicy === "function" ? (registry.operatorPolicy() ?? null) : null;
  };

  const decide = async function gate(req: GateRequest, resolved?: (resource: string) => void): Promise<GateResult> {
    const path = req.path;

    // Who the request says it is: normalised enums, never the raw User-Agent,
    // IP or headers. Stamped on every event this request emits, and upgraded
    // to verified only once the receipt checks out in step 4 — a User-Agent
    // or an AIFP-Agent-Id header is a claim, and scanners make that claim.
    let who: AgentIdentity = classifyAgent(req);
    const note = (e: GateEvent) => emit({ ...e, ...who });

    const agentHeader = req.header("AIFP-Agent-Id") ?? null;

    // ── Shadow ────────────────────────────────────────────────────────────
    // By the time a refusal is built its event has already been emitted, so
    // shadow has one job: keep the refusal as `aifp.shadow` and serve the
    // request instead. Same event stream as enforce; a 200 wherever enforce
    // would have sent 402, 403 or 503. Nothing is metered — a call enforce
    // refuses never consumed a unit either.
    const refuse = (resource: string, weight: number, r: Extract<GateResult, { ok: false }>): GateResult => {
      if (mode !== "shadow") return r;
      return {
        ok: true,
        status: 200,
        headers: { [HEADER_MODE]: "shadow", [HEADER_SHADOW_STATUS]: String(r.status) },
        aifp: {
          agent: agentHeader,
          receipt_id: "",
          resource,
          weight: 0,
          unit_quota: 0,
          used: 0,
          remaining: 0,
          mode: "shadow",
          shadow: { status: r.status, error: r.body.error, detail: r.body.detail, weight },
        },
      };
    };

    // `effectiveTier` is passed in per request, never taken from the closure. In
    // registry mode the weight comes from the MATCHED resource while the tier used
    // to come from the mount, so a premium route quoted unit_price_usd $0.0005 and
    // then metered 10 units — the agent was told one price and charged another.
    // Whatever tier is advertised here must be the one `weight` was derived from.
    const challenge = (resource: string, weight: number, effectiveTier: Tier, detail?: string): GateResult => {
      note({ kind: "402", resource, weight, detail });
      return refuse(resource, weight, {
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
      });
    };

    // `eventDetail` is what the dashboard reads; it differs from the body only
    // for an operator rule, where the caller is told "merchant policy" and the
    // event names the rule.
    const forbid = (resource: string, weight: number, detail: string, eventDetail: string = detail): GateResult => {
      note({ kind: "403", resource, weight, detail: eventDetail });
      return refuse(resource, weight, {
        ok: false,
        status: 403,
        headers: { "Content-Type": "application/json" },
        body: { error: "AIFP-403", detail },
      });
    };

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
        note({
          kind: "pricing_unavailable",
          resource: path,
          weight: 0,
          detail: "registry never loaded",
        });
        return refuse(path, 0, {
          ok: false,
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
          body: {
            error: "AIFP-503-PRICING",
            detail: "pricing unavailable — this gate has not been able to reach the AiFinPay control plane yet",
          },
        });
      }
      matched = options.registry.match(path);
    }

    const resource = matched ? matched.route_pattern : (options.resource ?? path);
    if (matched || options.resource) resolved?.(resource);
    // One source of truth for "what does this call cost": the tier the weight
    // is derived from is the tier the 402 advertises.
    const effectiveTier: Tier = matched ? ((matched.tier as Tier) ?? tier) : tier;
    const weight = matched ? (matched.unit_weight ?? weightForTier(effectiveTier)) : mountWeight;

    // The scope test runs against the request PATH, not the route pattern —
    // an agent's receipt names a real path, and "/api/lookup/*" is not one.
    // In static-mount mode the declared resource is the path the merchant
    // published, which is what the receipt was quoted for, so it wins over
    // req.path (which a mounted router may have already stripped a prefix off).
    const scopePath = options.registry ? path : (options.resource ?? path);

    // ── 2. Explicitly free resources ──────────────────────────────────────
    // paywall_enabled:false is the merchant saying "serve this to anyone". No
    // metering and no free-allowance spend: a free route must not quietly eat
    // an agent's prepaid units either.
    if (matched && matched.paywall_enabled === false) {
      if (
        options.allow &&
        !(await safeAllow(options.allow, {
          path,
          resource,
          weight,
          agent: agentHeader,
          receipt_id: null,
        }))
      ) {
        return forbid(resource, weight, "blocked by merchant policy");
      }
      note({ kind: "serve", resource, weight, agent: agentHeader });
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

    // ── 2b. WHO pays — the content-site exemption ─────────────────────────
    // Evaluated BEFORE the missing-receipt challenge, or a human reader would
    // meet the 402 this option exists to spare them from — and AFTER the
    // merchant-policy paywall_enabled check above, which is a stronger, per-
    // route statement. A predicate that throws charges: of the two wrong
    // answers, a 402 to one human is visible; a crawler served free is silent
    // and forever.
    //
    // knownAiAgent returns true for anything carrying AIFP-Receipt or
    // AIFP-Agent-Id, so a PAYING agent is never exempted into unmetered
    // service by a browser-looking User-Agent.
    // Served free, unmetered: the merchant's `allow` veto still has the last
    // word. Shared by the shouldCharge exemption and an operator rule that
    // says allow — the one difference is the `detail` naming the rule.
    const serveExempt = async (detail?: string, agent: string | null = agentHeader): Promise<GateResult> => {
      if (
        options.allow &&
        !(await safeAllow(options.allow, {
          path,
          resource,
          weight,
          agent,
          receipt_id: null,
        }))
      ) {
        return forbid(resource, weight, "blocked by merchant policy");
      }
      note({ kind: "serve", resource, weight, agent, exempt: true, ...(detail !== undefined ? { detail } : {}) });
      return {
        ok: true,
        status: 200,
        headers: { "AIFP-Paywall": "exempt" },
        aifp: {
          agent,
          receipt_id: "",
          resource,
          weight: 0,
          unit_quota: 0,
          used: 0,
          remaining: 0,
          mode: "exempt",
        },
      };
    };

    // ── 2a. The merchant's operator rules ─────────────────────────────────
    // allow / charge / block per operator, as saved on the dashboard. Decided
    // on what the request CLAIMS to be — a User-Agent, an AIFP-Agent-Id — with
    // one exception: when a verified_only rule would answer differently once
    // this request's receipt verifies, the decision waits for step 4, where
    // `verified` is settled. `charge` falls through to everything below, so a
    // policy with no rules changes nothing.
    const operatorPolicy = policyFor();
    const claimed = decideOperator(operatorPolicy, who);
    const onceVerified = req.header("AIFP-Receipt")
      ? decideOperator(operatorPolicy, { ...who, verified: true })
      : claimed;
    const operatorPending = claimed.action !== onceVerified.action || claimed.matched !== onceVerified.matched;
    const applyOperator = (d: OperatorDecision, agent?: string | null): Promise<GateResult> | GateResult | null => {
      if (d.action === "block") return forbid(resource, weight, "blocked by merchant policy (operator rule)", d.detail);
      if (d.action === "allow") return serveExempt(d.detail, agent);
      return null;
    };
    if (!operatorPending) {
      const decided = applyOperator(claimed);
      if (decided) return decided;
    }

    if (options.shouldCharge) {
      let charge = true;
      try {
        charge = await options.shouldCharge(req);
      } catch {
        charge = true;
      }
      if (!charge) return serveExempt();
    }

    // ── 3. No receipt → the 402 that teaches an agent how to pay ──────────
    const token = req.header("AIFP-Receipt");
    if (!token) return challenge(resource, weight, effectiveTier);

    // ── 4. Verify locally ─────────────────────────────────────────────────
    const v = await verify(token);
    if (!v.ok) {
      // The receipt did not verify, so the caller is what it claimed and a
      // pending operator decision is taken on the claim — before the
      // receipt's own refusal, which is the lesser statement.
      if (operatorPending) {
        const decided = applyOperator(claimed);
        if (decided) return decided;
      }
      if (v.kind === "expired") return challenge(resource, weight, effectiveTier, DETAIL_RECEIPT_EXPIRED);
      if (v.kind === "jwks_unavailable") {
        // Fail CLOSED. Failing open would turn a partner's paid API into a free
        // one for the length of our outage, which is a worse failure than a
        // 503 the agent will retry.
        note({ kind: "meter_error", resource, weight, detail: v.reason });
        return refuse(resource, weight, {
          ok: false,
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "30" },
          body: {
            error: "AIFP-503-METER",
            detail: "receipt verification is temporarily unavailable — retry shortly",
          },
        });
      }
      return forbid(resource, weight, DETAIL_VERIFY_FAILED);
    }
    const payload = v.payload;
    // Signature, issuer and audience verified: this is an AIFP agent, proven.
    // Everything that follows — a scope refusal, an exhausted batch, a serve —
    // is reported as verified, because the identity question is settled even
    // when the spend is refused.
    who = { operator: "aifinpay", ua_class: "aifp_agent", verified: true };
    // A verified_only rule now has its answer. An `allow` here is served free
    // without spending the receipt: the merchant said this caller does not pay.
    if (operatorPending) {
      const decided = applyOperator(onceVerified, payload.sub ?? null);
      if (decided) return decided;
    }

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
        `receipt type "${payload.typ_aifp}" is not spendable — this endpoint needs a quota receipt`
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
        `receipt is scoped to ${payload.resource} (${payload.scope || "exact"}), not ${scopePath}`
      );
    }

    if (options.requireAgentMatch && agentHeader && payload.sub && agentHeader !== payload.sub) {
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
      payload.unit_quota != null ? payload.unit_quota : (Number(payload.quota) || 1) * weightForTier(payload.tier)
    );
    // The counter must die with the receipt: never longer (a stale counter
    // refuses paid calls), never shorter (an expired counter makes the whole
    // batch spendable again). The receipt lives until the verifier stops
    // accepting it — exp plus the clock tolerance — so that is the TTL.
    const ttlMs = Math.max(1000, (payload.exp + clockToleranceSec) * 1000 - Date.now());

    // A single-use receipt has no counter headroom to protect it, so replay is
    // checked explicitly. A multi-use batch does not need it: replaying it just
    // spends it, which is what it is for.
    const wantsReplayCheck = replayMode === "always" || (replayMode === "auto" && limit <= 1);
    let nonceKey: string | undefined;
    if (wantsReplayCheck) {
      // No nonce means no way to tell a first spend from a replay. Keying on
      // `undefined` would not fail open, it would fail WEIRD: every nonce-less
      // receipt in the process shares one counter, so the first is served and
      // the rest are refused as "already spent" — a receipt rejected because a
      // different agent's receipt was also malformed.
      if (typeof payload.nonce !== "string" || payload.nonce === "") {
        return forbid(resource, weight, "single-use receipt carries no nonce");
      }
      nonceKey = `${keyPrefix}nonce:${payload.nonce}`;
      let seen: number;
      try {
        seen = await store.incrBy(nonceKey, 1, ttlMs);
      } catch (e) {
        return storeFailure(e);
      }
      if (seen > 1) return forbid(resource, weight, "receipt already spent (single-use)");
    }

    const usedKey = `${keyPrefix}used:${payload.receipt_id}`;
    let used: number;
    try {
      used = await store.incrBy(usedKey, weight, ttlMs);
    } catch (e) {
      // The nonce is recorded but nothing was metered. Closed, the agent is
      // told to retry — which a burned nonce would refuse as already spent.
      // Open, the call is served, so the nonce stays spent.
      if (onStoreError !== "open") await undo(store, nonceKey, 1);
      return storeFailure(e);
    }

    // Post-increment compare: whichever concurrent request receives the value
    // that crosses the limit is the one refused, exactly once. Reading first
    // and deciding second is how a batch gets overspent. The refused call then
    // takes back its own increment (and nonce), so the units that remain stay
    // spendable by a call that fits; only refused increments are undone, so
    // the units served can never exceed the limit.
    if (used > limit) {
      await undo(store, usedKey, weight);
      await undo(store, nonceKey, 1);
      return challenge(resource, weight, effectiveTier, DETAIL_QUOTA_EXHAUSTED);
    }

    note({ kind: "serve", resource, weight, agent: payload.sub, receipt_id: payload.receipt_id });
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
      note({ kind: "meter_error", resource, weight, detail });
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
      return refuse(resource, weight, {
        ok: false,
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
        body: { error: "AIFP-503-METER", detail: "quota store unavailable — retry shortly" },
      });
    }
  };
  return async (req) => {
    let registeredResource: string | undefined;
    const decided = await decide(
      req,
      options.reporting
        ? (resource) => {
            registeredResource = resource;
          }
        : undefined
    );
    // Every answer from a shadow gate says so — a served call as much as a
    // would-be refusal — so a site owner, and the AiFinPay site check, can
    // tell "gate installed, observing" from "no gate" on a 200.
    const result: GateResult =
      mode === "shadow" && decided.ok
        ? { ...decided, headers: { ...decided.headers, [HEADER_MODE]: "shadow" } }
        : decided;
    // Only explicitly registered patterns participate; a fallback request path
    // can contain caller identifiers. The adapter observes actual HTTP events.
    if (options.reporting && registeredResource) {
      const resource = result.ok ? result.aifp.resource : result.body.resource;
      if (
        resource === registeredResource &&
        ((result.ok && result.aifp.mode === "paid") || (!result.ok && result.status === 402))
      ) {
        return { ...result, reportingResource: resource };
      }
    }
    return result;
  };
}

/** A partner's veto must not become a 500 by throwing. A hook that blows up is
 *  treated as "no opinion" and the paid flow continues. */
async function safeAllow(
  allow: NonNullable<GateOptions["allow"]>,
  ctx: Parameters<NonNullable<GateOptions["allow"]>>[0]
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
export async function refundUnits(store: GateStore, ctx: AifpContext, keyPrefix = "aifp:"): Promise<void> {
  if (ctx.mode !== "paid" || ctx.weight <= 0) return;
  await undo(store, `${keyPrefix}used:${ctx.receipt_id}`, ctx.weight);
}

/** Take back an increment that bought nothing. Best effort by contract: a store
 *  without decrBy, or one failing right now, keeps the increment. */
async function undo(store: GateStore, key: string | undefined, by: number): Promise<void> {
  if (!store.decrBy || key === undefined) return;
  try {
    await store.decrBy(key, by);
  } catch {
    /* a failed undo must not fail the response */
  }
}
