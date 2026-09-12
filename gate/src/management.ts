// ──────────────────────────────────────────────────────────────────────────
// The merchant-secret half of the SDK: register your endpoints from code.
//
// Until this existed, the only way to tell AiFinPay "this route costs money"
// was to click through the dashboard's Paywall Builder. That is fine once and
// wrong forever after: routes are code, they change in pull requests, and a
// price that lives only in someone's browser session drifts from the app that
// serves it.
//
// `ensureResources` is the call a partner puts in their boot script. It is
// idempotent by route_pattern (the API's `upsert`), so running it on every
// deploy converges rather than accumulating — which matters more than it
// sounds: duplicate route_patterns make the matcher pick between equal-length
// patterns arbitrarily, and two records for the same path with different
// weights charge unpredictably.
//
// Everything written here lands in the same registry the dashboard reads, so
// it shows up in the panel on the next refresh. There is no sync job and no
// second store — see the README section on that.
// ──────────────────────────────────────────────────────────────────────────
import {
  AifpAuthError,
  AifpConflictError,
  AifpGateError,
  AifpValidationError,
} from "./errors.js";
import type {
  AifpResource,
  MerchantPublicView,
  MerchantStats,
  ResourceInput,
  SettlementRecord,
} from "./types.js";

export interface AifpMerchantOptions {
  merchantId?: string;
  secret?: string;
  /** Always api.aifinpay.io. Never the legacy .company domain: it 301s here,
   *  and a 301 makes some clients re-issue the request as a GET without the
   *  body — a create that appears to succeed and registers nothing. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** GET-only retries. */
  retries?: number;
}

const DEFAULT_BASE = "https://api.aifinpay.io";

export class AifpMerchant {
  readonly merchantId: string;
  readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: AifpMerchantOptions = {}) {
    const merchantId = opts.merchantId ?? process.env.AIFP_MERCHANT_ID ?? "";
    const secret = opts.secret ?? process.env.AIFP_MERCHANT_SECRET ?? "";
    if (!merchantId) {
      throw new AifpGateError(
        "AifpMerchant: merchantId is required (pass it, or set AIFP_MERCHANT_ID)",
      );
    }
    if (!secret) {
      throw new AifpGateError(
        "AifpMerchant: secret is required (pass it, or set AIFP_MERCHANT_SECRET)",
      );
    }
    this.merchantId = merchantId;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;

    // Non-enumerable so the secret cannot ride out in a JSON.stringify of a
    // config object, a structured log line, or an error-reporting breadcrumb.
    Object.defineProperty(this, "_secret", {
      value: secret,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /** Keeps the secret out of console.log(client) and util.inspect output. */
  toJSON(): Record<string, string> {
    return { merchantId: this.merchantId, baseUrl: this.baseUrl, secret: "[redacted]" };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `AifpMerchant { merchantId: '${this.merchantId}', baseUrl: '${this.baseUrl}', secret: '[redacted]' }`;
  }

  // ── Resources ───────────────────────────────────────────────────────────

  async listResources(): Promise<AifpResource[]> {
    const body = await this.request<{ resources: AifpResource[] }>("GET", "/resources");
    return body?.resources ?? [];
  }

  async getResource(resourceId: string): Promise<AifpResource | null> {
    const body = await this.request<{ resource: AifpResource } | null>(
      "GET",
      `/resources/${encodeURIComponent(resourceId)}`,
      undefined,
      { nullOn404: true },
    );
    return body ? body.resource : null;
  }

  /** Throws AifpConflictError when the route_pattern is already registered —
   *  use `ensureResources` if you want that to be a no-op instead. */
  async createResource(input: ResourceInput): Promise<AifpResource> {
    const body = await this.request<{ resource: AifpResource }>("POST", "/resources", input);
    return body.resource;
  }

  async updateResource(
    resourceId: string,
    patch: Partial<ResourceInput>,
  ): Promise<AifpResource> {
    const body = await this.request<{ resource: AifpResource }>(
      "PATCH",
      `/resources/${encodeURIComponent(resourceId)}`,
      patch,
    );
    return body.resource;
  }

  /** false when the resource was already gone — deleting twice is not an error
   *  worth stopping a teardown script for. */
  async deleteResource(resourceId: string): Promise<boolean> {
    const body = await this.request<{ ok: true } | null>(
      "DELETE",
      `/resources/${encodeURIComponent(resourceId)}`,
      undefined,
      { nullOn404: true },
    );
    return body != null;
  }

  /**
   * Declare the endpoints this service charges for. Safe on every boot.
   *
   * Sequential, not Promise.all: the server caps how fast one merchant may
   * write its registry, and a boot script that trips a rate limiter fails a
   * deploy for no reason. A dozen routes cost a dozen round-trips once per
   * release.
   */
  async ensureResources(
    inputs: ResourceInput[],
    opts: {
      /**
       * What to do when the route already exists.
       *
       * "replace" (default): converge to EXACTLY what this call declares —
       * absent fields reset to their defaults. Code owns the routes; a panel
       * edit lives until the next deploy. This is deliberate: merge semantics
       * would make one request body mean two different things depending on
       * whether the record existed.
       *
       * "skip": create only what is missing, never touch what exists — the
       * panel owns routes after birth. The skip is SILENT by design (it is
       * the normal case on every boot), so remember which mode you deployed:
       * "my code says premium, why is it standard?" is what this option does
       * when forgotten.
       */
      onExisting?: "replace" | "skip";
    } = {},
  ): Promise<AifpResource[]> {
    const onExisting = opts.onExisting ?? "replace";
    const existing =
      onExisting === "skip"
        ? new Map((await this.listResources()).map((r) => [r.route_pattern, r]))
        : null;
    const out: AifpResource[] = [];
    for (const input of inputs) {
      if (existing) {
        const have = existing.get(input.route_pattern);
        if (have) {
          out.push(have);
          continue;
        }
      }
      const body = await this.request<{ resource: AifpResource }>("POST", "/resources", {
        ...input,
        upsert: true,
      });
      const resource = body.resource;
      // The API answers 201 even when Redis was down and the record only
      // reached one process's memory: invisible to the dashboard, gone on the
      // next restart. Say so loudly — a deploy script that trusts a lying 201
      // ships a paywall nobody can see or edit.
      if (resource && resource.durable === false) {
        console.warn(
          `[@aifinpay/gate] resource ${resource.route_pattern} was stored non-durably ` +
            "(control-plane storage degraded) — it will not appear in the dashboard and will " +
            "not survive a restart. Re-run this step once the API reports healthy.",
        );
      }
      out.push(resource);
    }
    return out;
  }

  // ── Merchant record ─────────────────────────────────────────────────────

  async merchant(): Promise<MerchantPublicView> {
    return this.request<MerchantPublicView>("GET", "");
  }

  async updateMerchant(patch: {
    name?: string;
    pay_to?: Record<string, string>;
  }): Promise<MerchantPublicView> {
    return this.request<MerchantPublicView>("PATCH", "", patch);
  }

  async stats(): Promise<MerchantStats> {
    return this.request<MerchantStats>("GET", "/stats");
  }

  async activity(limit?: number): Promise<SettlementRecord[]> {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    const body = await this.request<SettlementRecord[] | { activity?: SettlementRecord[] }>(
      "GET",
      `/activity${qs}`,
    );
    return Array.isArray(body) ? body : body?.activity ?? [];
  }

  async receipts(): Promise<SettlementRecord[]> {
    const body = await this.request<SettlementRecord[] | { receipts?: SettlementRecord[] }>(
      "GET",
      "/receipts",
    );
    return Array.isArray(body) ? body : body?.receipts ?? [];
  }

  async setWebhook(url: string | null): Promise<{ merchant_id: string; webhook: unknown }> {
    return this.request("PUT", "/webhook", { url });
  }

  // ── Transport ───────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { nullOn404?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/v1/merchants/${encodeURIComponent(this.merchantId)}${path}`;
    const secret = (this as unknown as { _secret: string })._secret;
    // Retry GETs only. POST /resources is not idempotent unless `upsert` is
    // set, and a retried create is a duplicate route_pattern — the exact thing
    // the 409 exists to prevent.
    const attempts = method === "GET" ? this.retries + 1 : 1;

    let lastNetworkError: unknown = null;
    for (let i = 0; i < attempts; i++) {
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method,
          headers: {
            "AIFP-Merchant-Secret": secret,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastNetworkError = e;
        continue;
      }

      if (res.status === 404 && opts.nullOn404) return null as T;
      if (res.ok) return (await readJson(res)) as T;

      const payload = (await readJson(res)) as { detail?: string; resource_id?: string } | null;
      const detail = payload?.detail ?? `HTTP ${res.status}`;
      // The secret is never interpolated into any of these — an error message
      // ends up in logs, issue trackers and screenshots.
      if (res.status === 400) throw new AifpValidationError(detail);
      if (res.status === 401 || res.status === 403) {
        throw new AifpAuthError("invalid merchant secret");
      }
      if (res.status === 409) throw new AifpConflictError(detail, payload?.resource_id);
      if (res.status === 429) throw new AifpGateError(`rate limited by the AiFinPay API: ${detail}`);
      throw new AifpGateError(`AiFinPay API ${res.status}: ${detail}`);
    }

    throw new AifpGateError(
      `AiFinPay API unreachable at ${this.baseUrl}: ${
        lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError)
      }`,
    );
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
