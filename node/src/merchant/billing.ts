/**
 * Merchant-side helpers for the AiFinPay hosted gateway.
 *
 * When your API runs behind `gateway.aifinpay.io/{slug}/…`, the gateway
 * meters billing units and signs a per-action Billing Receipt for the
 * calling agent. Your API tells the gateway *what happened* by returning
 * a single-line JSON response header:
 *
 *   AIFP-Billing: {"action":"deep_research","cost_units":10,"category":"premium"}
 *
 * Only `action` is required. `cost_units` is informational — the gateway's
 * own action registry weight is the billing authority; the header value is
 * a hint/confirmation. Everything else is optional telemetry that ends up
 * on the signed receipt and the merchant dashboard.
 *
 * Usage (Express):
 *
 *   import { withBilling } from "@aifinpay/agent";
 *
 *   app.use(withBilling());                       // attaches res.setAifpBilling()
 *   app.post("/deep-research", (req, res) => {
 *     res.setAifpBilling({ action: "deep_research", cost_units: 10 });
 *     res.json(result);
 *   });
 *
 * Or classify centrally (header injected just before the response is sent):
 *
 *   app.use(withBilling((req) => ({
 *     action: req.path === "/deep-research" ? "deep_research" : "search",
 *     cost_units: req.path === "/deep-research" ? 10 : 1,
 *   })));
 */

/** Response header name the AiFinPay gateway reads billing metadata from. */
export const AIFP_BILLING_HEADER = "AIFP-Billing";

/**
 * Billing metadata for one merchant action, as read by the AiFinPay gateway
 * (`routes/gateway.js` in the operator backend).
 */
export interface BillingMeta {
  /** Human action name, e.g. `"deep_research"`. Required, non-empty. */
  action: string;
  /**
   * Billing units this action costs. Informational — the gateway uses its
   * own registry weight as the authority; this is a hint/confirmation.
   */
  cost_units?: number;
  /** Optional action category, e.g. `"premium"`. */
  category?: string;
  /** Optional upstream execution time in milliseconds. */
  execution_time_ms?: number;
  /** Optional response payload size in bytes. */
  bytes?: number;
  /** Optional token count (for LLM-shaped actions). */
  tokens?: number;
  /** Optional merchant-side status string, e.g. `"ok"`. */
  status?: string;
}

const NUMERIC_FIELDS = [
  "cost_units",
  "execution_time_ms",
  "bytes",
  "tokens",
] as const;

const STRING_FIELDS = ["category", "status"] as const;

/**
 * Validate + normalize billing metadata into the compact single-line JSON
 * string for the `AIFP-Billing` response header.
 *
 * - `action` must be a non-empty string — throws `TypeError` otherwise.
 * - Numeric fields are coerced to integers; negatives clamp to 0;
 *   non-finite values throw `TypeError`.
 * - `undefined`/`null` fields are dropped.
 * - Output is compact JSON (no whitespace); `JSON.stringify` escapes any
 *   newlines inside strings, so the value is always a single line.
 */
export function billingHeader(meta: BillingMeta): string {
  if (typeof meta?.action !== "string" || meta.action.trim() === "") {
    throw new TypeError(
      "AIFP-Billing: 'action' is required and must be a non-empty string",
    );
  }
  const out: Record<string, string | number> = { action: meta.action.trim() };

  for (const key of NUMERIC_FIELDS) {
    const raw = meta[key];
    if (raw === undefined || raw === null) continue;
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n)) {
      throw new TypeError(`AIFP-Billing: '${key}' must be a finite number`);
    }
    out[key] = Math.max(0, n);
  }

  for (const key of STRING_FIELDS) {
    const raw = meta[key];
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (s !== "") out[key] = s;
  }

  return JSON.stringify(out);
}

// ── Express-style middleware ──────────────────────────────────────────────
// Structural types so the SDK does not depend on @types/express.

interface MinimalRequest {
  [key: string]: unknown;
}

interface MinimalResponse {
  setHeader(name: string, value: string): unknown;
  headersSent: boolean;
  write?: (...args: unknown[]) => unknown;
  end: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/** `res` augmented by {@link withBilling} with the `setAifpBilling` helper. */
export interface BillingResponse extends MinimalResponse {
  /** Set the `AIFP-Billing` header for this response. Call before sending. */
  setAifpBilling(meta: BillingMeta): void;
}

/**
 * Express-style middleware that wires `AIFP-Billing` emission.
 *
 * Two ways to use it (they compose — an explicit `setAifpBilling` call
 * always wins over `classify`):
 *
 * 1. **Per-handler** — the middleware attaches `res.setAifpBilling(meta)`;
 *    call it inside your handler *before* `res.json(...)` / `res.send(...)`.
 *    This sets the header immediately, well before headers flush.
 *
 * 2. **Centralized** — pass a `classify(req, res)` function returning
 *    {@link BillingMeta} (or `null`/`undefined` to skip). The middleware
 *    patches `res.write`/`res.end` so `classify` runs and the header is set
 *    at the last moment *before* headers are flushed to the socket —
 *    `res.on("finish")` would be too late to set a header, which is why the
 *    write/end patch is used instead.
 *
 * `classify` errors are swallowed: billing telemetry must never break the
 * merchant's actual response.
 */
export function withBilling(
  classify?: (req: MinimalRequest, res: MinimalResponse) => BillingMeta | null | undefined,
): (req: MinimalRequest, res: MinimalResponse, next: () => void) => void {
  return function aifpBillingMiddleware(req, res, next) {
    let done = false;

    (res as BillingResponse).setAifpBilling = (meta: BillingMeta) => {
      res.setHeader(AIFP_BILLING_HEADER, billingHeader(meta));
      done = true;
    };

    const inject = () => {
      if (done || res.headersSent) return;
      done = true;
      if (!classify) return;
      try {
        const meta = classify(req, res);
        if (meta) res.setHeader(AIFP_BILLING_HEADER, billingHeader(meta));
      } catch {
        /* telemetry must never break the response */
      }
    };

    // Headers flush on the first write()/end() — inject just before.
    if (typeof res.write === "function") {
      const origWrite = res.write.bind(res);
      res.write = (...args: unknown[]) => {
        inject();
        return origWrite(...args);
      };
    }
    const origEnd = res.end.bind(res);
    res.end = (...args: unknown[]) => {
      inject();
      return origEnd(...args);
    };

    next();
  };
}
