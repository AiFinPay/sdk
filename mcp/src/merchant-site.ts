/**
 * Who may be paid when the owner set no AIFINPAY_GATEWAY_ORIGINS (owner
 * decision, 2026-10-22): only a merchant whose site the AiFinPay backend
 * reports as DNS-verified and, for a site running its own paywall, whose site
 * is the host this payment is for.
 *
 * Without it, any page an agent was steered to could answer 402 with the id of
 * any registered merchant, and the backend would quote that merchant: quotes
 * bind (merchant, resource), not the origin the 402 came from. With it, the
 * payee is the verified owner of the site the agent is actually using.
 *
 * The merchant id checked here is the one in the backend-signed quote, never
 * the 402's, and the check runs in onPrepared — before anything is signed into
 * the journal or broadcast — so a refusal pays nothing.
 */

export class UnverifiedMerchantSiteError extends Error {
  constructor(
    public readonly merchantId: string,
    public readonly reason: string
  ) {
    super(`Not paid: merchant ${merchantId} ${reason}. Nothing was signed or sent.`);
    this.name = "UnverifiedMerchantSiteError";
  }
}

type MerchantView = { merchant_id?: unknown; site_url?: unknown; site_verified?: unknown };

const hostOf = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

export async function assertVerifiedMerchantSite(opts: {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /** The configured AiFinPay backend; the same origin that signed the quote. */
  apiBase: string;
  /** From the backend-signed quote. */
  merchantId: string;
  /** The URL payable_fetch was asked to fetch. */
  url: URL;
  /** "gateway": the AiFinPay hosted gateway serves it, so no host to compare. */
  pathMode: "gateway" | "direct";
}): Promise<void> {
  const { merchantId } = opts;
  let body: MerchantView | null = null;
  try {
    const res = await opts.fetchImpl(
      new URL(`/v1/merchants/${encodeURIComponent(merchantId)}`, opts.apiBase).href,
      { headers: { accept: "application/json" }, redirect: "error" }
    );
    if (res.ok) body = (await res.json()) as MerchantView;
  } catch {
    body = null;
  }
  if (!body || body.merchant_id !== merchantId)
    throw new UnverifiedMerchantSiteError(merchantId, "could not be confirmed with AiFinPay");
  if (body.site_verified !== true)
    throw new UnverifiedMerchantSiteError(merchantId, "has not verified its site with AiFinPay");
  if (opts.pathMode === "direct") {
    const site = hostOf(body.site_url);
    if (!site || site !== opts.url.hostname.toLowerCase())
      throw new UnverifiedMerchantSiteError(
        merchantId,
        `is verified for ${site ?? "no https site"}, not ${opts.url.hostname}`
      );
  }
}
