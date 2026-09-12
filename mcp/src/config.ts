/** Runtime configuration loaded from env. */
export interface McpConfig {
  /** Base58 secret to load the agent identity. If absent, a fresh keypair is
   *  generated AND printed to stderr at startup with a "save this!" warning. */
  agentSecretB58?: string;

  /** Custom AiFinPay backend URL. Defaults to production. */
  baseUrl?: string;

  /** Request timeout in ms. */
  timeoutMs?: number;

  /** Hard cap on a single payment to prevent runaway agents. */
  maxAmountUsd?: number;

  /** Gateway origins this agent may settle against.
   *
   *  The SDK has always supported this (parseGatewayUrl in @aifinpay/agent) and
   *  this wrapper never exposed it, so a self-hosted merchant was unreachable:
   *  payable_fetch reached the 402 and then refused with "dev.ratersapp.com is
   *  not a known AiFinPay gateway; allowed: https://gateway.aifinpay.io".
   *  Observed in an external E2E run on 2026-08-27.
   *
   *  Set by the OPERATOR, exact origins only, never a wildcard. The refusal it
   *  relaxes is not paranoia: a 402 is unauthenticated, so paying an
   *  unrecognised host means paying whoever answered. Naming a host here is a
   *  statement that you know who that is. */
  gatewayOrigins?: string[];

  /** Hosts whose DNS pre-check is skipped, exact names only.
   *
   *  safe-fetch resolves a hostname and refuses if any answer is a private
   *  address — an SSRF guard. Behind an HTTP proxy the client cannot resolve at
   *  all (getaddrinfo EAI_AGAIN), so every host is refused for the wrong reason.
   *
   *  This is deliberately NOT a proxy-detection switch that disables the check
   *  globally: that would turn one environment quirk into a blanket SSRF
   *  bypass. An operator names the hosts they vouch for, one at a time, and the
   *  guard stays on for everything else. */
  trustedHosts?: string[];

  /** Optional log destination (defaults to stderr). */
  logFn?: (level: "info" | "warn" | "error", msg: string) => void;
}

export function loadConfigFromEnv(): McpConfig {
  return {
    agentSecretB58: process.env.AIFINPAY_AGENT_SECRET || undefined,
    baseUrl: process.env.AIFINPAY_BASE_URL || undefined,
    timeoutMs: process.env.AIFINPAY_TIMEOUT_MS
      ? Number(process.env.AIFINPAY_TIMEOUT_MS)
      : undefined,
    maxAmountUsd: process.env.AIFINPAY_MAX_USD
      ? Number(process.env.AIFINPAY_MAX_USD)
      : undefined,
    gatewayOrigins: splitOrigins(process.env.AIFINPAY_GATEWAY_ORIGINS),
    trustedHosts: splitList(process.env.AIFINPAY_TRUSTED_HOSTS),
  };
}

/** Comma-separated list → trimmed entries, or undefined when unset/empty.
 *  Undefined and [] mean different things downstream: undefined keeps the SDK
 *  default, [] would mean "no origin is payable". An operator who sets the
 *  variable to an empty string means the former. */
function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

/** Same, but each entry must be a bare https origin.
 *  A path or a wildcard here would read as allowed and match nothing, which is
 *  the failure that looks like the feature is broken rather than misconfigured. */
function splitOrigins(raw: string | undefined): string[] | undefined {
  const list = splitList(raw);
  if (!list) return undefined;
  for (const entry of list) {
    let u: URL;
    try { u = new URL(entry); }
    catch { throw new Error(`AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not a URL`); }
    if (u.origin !== entry.replace(/\/+$/, "")) {
      throw new Error(
        `AIFINPAY_GATEWAY_ORIGINS: "${entry}" must be a bare origin like https://dev.example.com `
        + `(got path/query "${u.pathname}${u.search}")`,
      );
    }
    // WHATWG URL accepts "*" in a hostname, so new URL("https://*.example.com")
    // parses and its origin round-trips — the entry would be stored, matched
    // against nothing, and read as "I allowed this host". Rejecting it here is
    // the difference between a misconfiguration that says so and one that looks
    // like the feature is broken.
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.startsWith("-") || u.hostname.includes("..")) {
      throw new Error(
        `AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not a plain hostname. `
        + `Wildcards are not supported — name each origin you settle against.`,
      );
    }
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      throw new Error(`AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not https — refusing to settle over plaintext`);
    }
  }
  return list;
}
