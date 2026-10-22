import type { ToolContext } from "./server.js";

/**
 * The owner's dashboard Controls for this agent, read by the agent itself.
 *
 * The backend enforces the policy an owner sets under My Agents → Controls on
 * every /v1/quote and /v1/pay for a claimed agent, but until
 * GET /v1/agents/:address/policy existed the agent could not read it: a 403
 * agent_policy at quote time had no explanation, and payment_setup_status
 * could only talk about env. This reads the same view the owner sees.
 *
 * The request is proven by the agent's own key — EIP-191 over the statement
 * below, with the lowercase address, which is what the backend verifies
 * against — and is read-only: nothing in the response grants anything, and
 * nothing here can change a limit. A failure to read is reported as unknown,
 * never treated as "no limits": the backend applies the policy whether or not
 * this read succeeded.
 */

export const CONTROLS_URL = "https://dash.aifinpay.io";
const DEFAULT_ISSUER = "https://api.aifinpay.io";
/** How long the signed statement is valid; the backend accepts at most 300 s. */
const STATEMENT_LIFETIME_S = 60;

export interface DashboardPolicy {
  per_tx_cap_usd: number | null;
  daily_cap_usd: number | null;
  merchant_allowlist: string[] | null;
  expires_at: number | null;
  paused: boolean;
}

export type DashboardStatus =
  | { linked: true; policy: DashboardPolicy; controls: string }
  | { linked: false; controls: string }
  | { linked: "unknown"; reason: string; controls: string };

/** The exact bytes the backend verifies: aifinpay-web routes/me-agents.js policyReadMessage. */
export function policyReadStatement(issuer: string, address: string, expiresAt: number): string {
  return JSON.stringify(["AiFinPay agent policy read v1", issuer, address, expiresAt]);
}

/** The API this server quotes and pays through, which is also the statement's issuer. */
export function policyIssuer(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_ISSUER).replace(/\/+$/, "");
}

export async function readDashboardPolicy(ctx: ToolContext): Promise<DashboardStatus> {
  const controls = CONTROLS_URL;
  const issuer = policyIssuer(ctx.config.baseUrl);
  const address = ctx.agent.evmAddress.toLowerCase();
  const expiresAt = Math.floor(Date.now() / 1000) + STATEMENT_LIFETIME_S;
  try {
    const signature = await ctx.agent.evmAccount.signMessage({
      message: policyReadStatement(issuer, address, expiresAt),
    });
    const response = await ctx.agent.inner.fetchImpl(`${issuer}/v1/agents/${address}/policy`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "AIFP-Agent-Expires": String(expiresAt),
        "AIFP-Agent-Signature": signature,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(ctx.config.timeoutMs ?? 10_000),
    });
    if (response.status === 404) return { linked: false, controls };
    if (!response.ok) return { linked: "unknown", reason: `HTTP ${response.status}`, controls };
    const body = (await response.json()) as { claimed?: unknown; policy?: unknown };
    const policy = parsePolicy(body?.policy);
    if (body?.claimed !== true || !policy) return { linked: "unknown", reason: "malformed policy", controls };
    return { linked: true, policy, controls };
  } catch (error) {
    // A network error's message can carry the host and more; its kind is enough.
    return { linked: "unknown", reason: (error as Error)?.name || "request failed", controls };
  }
}

/** Only the owner's limits, each in the one type the dashboard writes; anything else is malformed. */
function parsePolicy(raw: unknown): DashboardPolicy | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const usd = (value: unknown): number | null | undefined =>
    value === null || value === undefined
      ? null
      : typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
  const perTx = usd(p.per_tx_cap_usd);
  const daily = usd(p.daily_cap_usd);
  const expires =
    p.expires_at === null || p.expires_at === undefined
      ? null
      : typeof p.expires_at === "number" && Number.isSafeInteger(p.expires_at)
        ? p.expires_at
        : undefined;
  // Merchant ids are repeated to the model, so only plain identifiers pass.
  const allowlist =
    p.merchant_allowlist === null || p.merchant_allowlist === undefined
      ? null
      : Array.isArray(p.merchant_allowlist) &&
          p.merchant_allowlist.every((m) => typeof m === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(m))
        ? (p.merchant_allowlist as string[])
        : undefined;
  if (perTx === undefined || daily === undefined || expires === undefined || allowlist === undefined) return undefined;
  if (typeof p.paused !== "boolean") return undefined;
  return {
    per_tx_cap_usd: perTx,
    daily_cap_usd: daily,
    merchant_allowlist: allowlist,
    expires_at: expires,
    paused: p.paused,
  };
}

/** Why the backend will refuse every quote for this agent right now, if it will. */
export function dashboardRefusal(status: DashboardStatus, now: Date = new Date()): string | undefined {
  if (status.linked !== true) return undefined;
  if (status.policy.paused)
    return `The owner paused payments for this agent in the dashboard Controls: AiFinPay refuses new quotes until they resume at ${status.controls}. Nothing will be paid; tell the owner and stop.`;
  if (status.policy.expires_at !== null && status.policy.expires_at < Math.floor(now.getTime() / 1000))
    return `The owner's dashboard Controls for this agent expired on ${new Date(status.policy.expires_at * 1000).toISOString().slice(0, 10)}: AiFinPay refuses new quotes until the owner sets a new expiry at ${status.controls}. Tell the owner and stop.`;
  return undefined;
}

/** One sentence for next_step about the dashboard, given what was read. */
export function dashboardSentence(status: DashboardStatus): string {
  if (status.linked === true) {
    const p = status.policy;
    const cap = (value: number | null) => (value === null ? "no limit" : `$${value}`);
    const expiry =
      p.expires_at === null ? "" : `, valid until ${new Date(p.expires_at * 1000).toISOString().slice(0, 10)}`;
    return (
      `Dashboard Controls, enforced by AiFinPay on every quote and payment: per payment ${cap(p.per_tx_cap_usd)}, ` +
      `per day ${cap(p.daily_cap_usd)}${p.merchant_allowlist ? `, only merchants ${p.merchant_allowlist.join(", ")}` : ""}${expiry}. ` +
      `The owner changes them at ${status.controls}; the local limits of this server still apply underneath.`
    );
  }
  if (status.linked === false)
    return (
      `This agent is not linked to an owner's dashboard: offer it — the owner generates a one-time URL at ${status.controls} → My Agents → Claim via MCP ` +
      `and gives it to agent_claim_self; from then on the owner sets the working limits in Controls.`
    );
  return `The dashboard Controls could not be read (${status.reason}); AiFinPay still enforces them on every quote and payment.`;
}
