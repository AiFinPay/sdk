import { readFileSync } from "node:fs";
import { validatePaymentConfig, type McpConfig } from "./config.js";
import { policyIssuer, STATEMENT_LIFETIME_S } from "./dashboard-policy.js";
import { payChain, type PayChain } from "./pay-chains.js";
import type { ToolContext } from "./server.js";

const MCP_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const REPORT_TIMEOUT_MS = 5_000;

/** The summary of this server's env the owner's dashboard shows: these keys, in this order, and nothing else. */
export interface LocalSettings {
  mcp_version: string;
  payments_enabled: boolean;
  site_origins: string[] | null;
  max_usd: number;
  daily_usd: number;
  pay_chain: string;
  pay_asset: string;
}

/** Address and settings the backend already answered 200 or 409 for in this process. */
const reported = new Set<string>();

/** The exact bytes the backend verifies. */
export function localSettingsStatement(
  issuer: string,
  address: string,
  expiresAt: number,
  settings: LocalSettings
): string {
  return JSON.stringify(["AiFinPay agent local settings v1", issuer, address, expiresAt, settings]);
}

/** Undefined when the settings would be refused for payments anyway, so a report would mislead. */
export function localSettings(config: McpConfig): LocalSettings | undefined {
  let chain: PayChain;
  try {
    chain = payChain(config.payChain);
    validatePaymentConfig({ ...config, paymentsEnabled: true });
  } catch {
    return undefined;
  }
  const { maxAmountUsd, dailyAmountUsd } = config;
  if (!positiveUsd(maxAmountUsd) || !positiveUsd(dailyAmountUsd)) return undefined;
  return {
    mcp_version: MCP_VERSION,
    payments_enabled: Boolean(config.paymentsEnabled),
    site_origins: config.gatewayOrigins ?? null,
    max_usd: maxAmountUsd,
    daily_usd: dailyAmountUsd,
    pay_chain: chain.name,
    pay_asset: config.payAsset ?? chain.native,
  };
}

function positiveUsd(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Best effort, signed by the agent's own EVM key: never throws, and no tool answer depends on it. */
export async function reportLocalSettings(ctx: ToolContext): Promise<void> {
  try {
    const settings = localSettings(ctx.config);
    if (!settings) return;
    const address = ctx.agent.evmAddress.toLowerCase();
    const key = JSON.stringify([address, settings]);
    if (reported.has(key)) return;
    const issuer = policyIssuer(ctx.config.baseUrl);
    const expiresAt = Math.floor(Date.now() / 1000) + STATEMENT_LIFETIME_S;
    const signature = await ctx.agent.evmAccount.signMessage({
      message: localSettingsStatement(issuer, address, expiresAt, settings),
    });
    const response = await ctx.agent.inner.fetchImpl(`${issuer}/v1/agents/${address}/local-settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "AIFP-Agent-Expires": String(expiresAt),
        "AIFP-Agent-Signature": signature,
      },
      body: JSON.stringify(settings),
      redirect: "manual",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    // 409: a report signed later is already stored.
    if (response.status === 200 || response.status === 409) reported.add(key);
  } catch {
    // Not reported; the next call tries again.
  }
}
