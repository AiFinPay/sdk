/** Runtime configuration loaded from env. */
export interface McpConfig {
  /** Legacy base58 secret, after SEED_HASH and the project agents file. */
  agentSecretB58?: string;
  /** A 32-byte hex seed, used directly without an additional hash. */
  seedHash?: string;
  agentsFile?: string;
  agentId?: string;
  walletHome?: string;
  walletPassphrase?: string;

  /** Custom AiFinPay backend URL. Defaults to production. */
  baseUrl?: string;

  /** Request timeout in ms. */
  timeoutMs?: number;

  /** Hard cap on a single payment to prevent runaway agents. */
  maxAmountUsd?: number;

  /** Explicit gateway origins trusted by the operator. Does not bypass the
   * request-level DNS/private-address checks. Undefined keeps the SDK default. */
  gatewayOrigins?: string[];

  /** Optional log destination (defaults to stderr). */
  logFn?: (level: "info" | "warn" | "error", msg: string) => void;
}

export function loadConfigFromEnv(): McpConfig {
  return {
    seedHash: process.env.SEED_HASH,
    agentsFile: process.env.AIFINPAY_AGENTS_FILE || undefined,
    agentId: process.env.AIFINPAY_AGENT_ID || undefined,
    walletHome: process.env.AIFINPAY_HOME || undefined,
    walletPassphrase: process.env.AIFINPAY_WALLET_PASSPHRASE || undefined,
    agentSecretB58: process.env.AIFINPAY_AGENT_SECRET || undefined,
    baseUrl: process.env.AIFINPAY_BASE_URL || undefined,
    timeoutMs: process.env.AIFINPAY_TIMEOUT_MS
      ? Number(process.env.AIFINPAY_TIMEOUT_MS)
      : undefined,
    maxAmountUsd: process.env.AIFINPAY_MAX_USD
      ? Number(process.env.AIFINPAY_MAX_USD)
      : undefined,
    gatewayOrigins: parseGatewayOrigins(process.env.AIFINPAY_GATEWAY_ORIGINS),
  };
}

function parseGatewayOrigins(raw: string | undefined): string[] | undefined {
  const entries = raw?.split(",").map(value => value.trim()).filter(Boolean);
  if (!entries?.length) return undefined;
  return entries.map(entry => {
    let url: URL;
    try { url = new URL(entry); }
    catch { throw new Error("AIFINPAY_GATEWAY_ORIGINS entries must be HTTPS origins"); }
    if (url.protocol !== "https:") {
      throw new Error("AIFINPAY_GATEWAY_ORIGINS entries must use HTTPS");
    }
    if (url.origin !== entry.replace(/\/+$/, "") || !/^[a-z0-9.-]+$/i.test(url.hostname)
      || url.hostname.startsWith("-") || url.hostname.includes("..")) {
      throw new Error("AIFINPAY_GATEWAY_ORIGINS requires exact bare origins without paths, queries, credentials or wildcards");
    }
    return url.origin;
  });
}
