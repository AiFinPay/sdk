import { paymentStableAsset, solanaStableMint } from "@aifinpay/agent";
import type { EvmWalletClient } from "@aifinpay/agent";
import { payChain } from "./pay-chains.js";

/** Runtime configuration loaded from env. */
export interface McpConfig {
  /** Legacy base58 secret, after SEED_HASH and the project agents file. */
  agentSecretB58?: string;
  /** 32-byte hex seed, consumed exactly as AiFinPayAgent.fromSeed does. */
  seedHash?: string;
  agentsFile?: string;
  agentId?: string;
  walletHome?: string;
  walletPassphrase?: string;
  /** Child wallet number from a seed or indexed wallet keystore. */
  walletIndex?: number;
  /** Programmatic external EVM signer supplied by an embedding MCP host. */
  evmWalletClient?: EvmWalletClient;
  /** Dev environment. EVM payments stay live-only; Solana requires explicit devnet. */
  devMode?: boolean;

  /** Custom AiFinPay backend URL. Defaults to production. */
  baseUrl?: string;

  /** Request timeout in ms. */
  timeoutMs?: number;

  /** On unless the owner sets AIFINPAY_PAYMENTS_ENABLED=0; never accepted from tool arguments.
   *  An unfunded wallet spends nothing, and the built-in ceiling below bounds a funded one. */
  paymentsEnabled?: boolean;
  /** Payments are on because AIFINPAY_PAYMENTS_ENABLED is unset. A refused payment setting
   *  then leaves the server running read-only, with payment_setup_status naming the refusal;
   *  an explicit =1 (or a programmatic paymentsEnabled) stops the server, as it always did. */
  paymentsByDefault?: boolean;
  /** Names of the limit variables the owner set in env to lower the built-in ceiling;
   *  payment_setup_status reports each limit's source from this. */
  ownerOverrides?: string[];
  dailyAmountUsd?: number;
  /** Chain payable_fetch settles on: "polygon" (default), another supported EVM chain, or "solana". Set by
   *  the owner only; never inferred from a quote or a tool argument. */
  payChain?: string;
  /** RPC for the pay chain; defaults to the chain's public RPC. */
  rpcUrl?: string;
  /** Gas cap per payment, in the pay chain's native currency (POL, ETH). */
  maxGas?: string;
  /** Owner-selected cluster, independently bound to live/prod or dev mode. */
  solanaNetwork?: "mainnet" | "devnet";
  /** Integer lamports for transaction fees and required account rent. */
  maxFeeLamports?: string;
  /** Same cap under its original name; accepted on Polygon only. */
  maxGasPol?: string;
  /** What payable_fetch pays with: the chain's native currency (default) or a
   *  stablecoin the SDK pins for that chain, e.g. "USDC". Gas is native either way. */
  payAsset?: string;

  /** Hard cap on a single payment to prevent runaway agents. */
  maxAmountUsd?: number;

  /** Optional allowlist of gateway origins this agent may settle against.
   *
   *  Unset (the default since 2.12.1), payable_fetch accepts the https origin
   *  of the URL it is given, and pays only if the merchant in the backend-signed
   *  quote has a DNS-verified site that is that origin's host (any verified
   *  merchant on the AiFinPay hosted gateway) — see ../merchant-site.ts. The
   *  402 never decides who is paid; the ceiling below and the owner's dashboard
   *  Controls still apply.
   *  Before 2.12.1 this variable was required, and an unlisted origin was
   *  refused by name (observed in an external E2E run on 2026-08-27).
   *
   *  Set by the OPERATOR, exact https origins only, never a wildcard, it
   *  narrows that default: an origin not listed is refused before any quote.
   *  Naming a host here is a statement that you know who that is. */
  gatewayOrigins?: string[];

  /** AIFP-1 resource identity: merchant slug or full direct request path.
   *  Unset, payable_fetch infers it per URL: the hosted gateway
   *  (https://gateway.aifinpay.io) uses the slug, any other origin the path. */
  gatewayPathMode?: "gateway" | "direct";

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
  if (process.env.AIFINPAY_MODE && !["live", "dev"].includes(process.env.AIFINPAY_MODE)) {
    throw new Error("AIFINPAY_MODE must be live or dev");
  }
  if (process.env.AIFINPAY_PAYMENTS_ENABLED && !["0", "1"].includes(process.env.AIFINPAY_PAYMENTS_ENABLED)) {
    throw new Error("AIFINPAY_PAYMENTS_ENABLED must be 0 or 1");
  }
  return {
    paymentsEnabled: process.env.AIFINPAY_PAYMENTS_ENABLED !== "0",
    paymentsByDefault: !process.env.AIFINPAY_PAYMENTS_ENABLED,
    ownerOverrides: [
      ...(process.env.AIFINPAY_MAX_USD ? ["AIFINPAY_MAX_USD"] : []),
      ...(process.env.AIFINPAY_DAILY_USD ? ["AIFINPAY_DAILY_USD"] : []),
    ],
    dailyAmountUsd: ownerCeiling("AIFINPAY_DAILY_USD", process.env.AIFINPAY_DAILY_USD, DEFAULT_DAILY_USD),
    payChain: process.env.AIFINPAY_PAY_CHAIN || undefined,
    rpcUrl: process.env.AIFINPAY_RPC_URL || undefined,
    maxGas: process.env.AIFINPAY_MAX_GAS || undefined,
    solanaNetwork: parseSolanaNetwork(process.env.AIFINPAY_SOLANA_NETWORK),
    maxFeeLamports: process.env.AIFINPAY_MAX_FEE_LAMPORTS || undefined,
    maxGasPol: process.env.AIFINPAY_MAX_GAS_POL || undefined,
    payAsset: process.env.AIFINPAY_PAY_ASSET || undefined,
    devMode: process.env.AIFINPAY_MODE === "dev",
    seedHash: process.env.SEED_HASH,
    agentsFile: process.env.AIFINPAY_AGENTS_FILE || undefined,
    agentId: process.env.AIFINPAY_AGENT_ID || undefined,
    walletHome: process.env.AIFINPAY_HOME || undefined,
    walletPassphrase: process.env.AIFINPAY_WALLET_PASSPHRASE || undefined,
    walletIndex: parseWalletIndex(process.env.AIFINPAY_WALLET_INDEX),
    agentSecretB58: process.env.AIFINPAY_AGENT_SECRET || undefined,
    baseUrl: process.env.AIFINPAY_BASE_URL || undefined,
    timeoutMs: process.env.AIFINPAY_TIMEOUT_MS ? Number(process.env.AIFINPAY_TIMEOUT_MS) : undefined,
    maxAmountUsd: ownerCeiling("AIFINPAY_MAX_USD", process.env.AIFINPAY_MAX_USD, DEFAULT_MAX_USD),
    gatewayOrigins: splitOrigins(process.env.AIFINPAY_GATEWAY_ORIGINS),
    gatewayPathMode: parseGatewayPathMode(process.env.AIFINPAY_GATEWAY_PATH_MODE),
    trustedHosts: splitList(process.env.AIFINPAY_TRUSTED_HOSTS),
  };
}

function parseWalletIndex(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("AIFINPAY_WALLET_INDEX must be a non-negative integer");
  }
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index > 0xffffffff) {
    throw new Error("AIFINPAY_WALLET_INDEX must be between 0 and 4294967295");
  }
  return index;
}

function parseSolanaNetwork(raw: string | undefined): "mainnet" | "devnet" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "mainnet" || raw === "devnet") return raw;
  throw new Error("AIFINPAY_SOLANA_NETWORK must be mainnet or devnet");
}

function parseGatewayPathMode(raw: string | undefined): "gateway" | "direct" | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw === "gateway" || raw === "direct") return raw;
  throw new Error("AIFINPAY_GATEWAY_PATH_MODE must be either gateway or direct");
}

/** Comma-separated list → trimmed entries, or undefined when unset/empty.
 *  Undefined and [] mean different things downstream: undefined keeps the SDK
 *  default, [] would mean "no origin is payable". An operator who sets the
 *  variable to an empty string means the former. */
function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    try {
      u = new URL(entry);
    } catch {
      throw new Error(`AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not a URL`);
    }
    if (u.origin !== entry.replace(/\/+$/, "")) {
      throw new Error(
        `AIFINPAY_GATEWAY_ORIGINS: "${entry}" must be a bare origin like https://dev.example.com ` +
          `(got path/query "${u.pathname}${u.search}")`
      );
    }
    // WHATWG URL accepts "*" in a hostname, so new URL("https://*.example.com")
    // parses and its origin round-trips — the entry would be stored, matched
    // against nothing, and read as "I allowed this host". Rejecting it here is
    // the difference between a misconfiguration that says so and one that looks
    // like the feature is broken.
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.startsWith("-") || u.hostname.includes("..")) {
      throw new Error(
        `AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not a plain hostname. ` +
          `Wildcards are not supported — name each origin you settle against.`
      );
    }
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      throw new Error(`AIFINPAY_GATEWAY_ORIGINS: "${entry}" is not https — refusing to settle over plaintext`);
    }
  }
  return list;
}

/** Built-in spending ceiling (owner decision 2026-10-20): $5 per payment, $20 per
 *  24 h. The env values can only lower it; a higher value is refused so a
 *  pasted config cannot raise the ceiling above what the dashboard Controls
 *  are meant to manage. */
export const DEFAULT_MAX_USD = 5;
export const DEFAULT_DAILY_USD = 20;
/** Gas cap per payment on Polygon when the owner sets none: the worst case at
 *  ~280 gwei is ~0.10 POL paying in POL and ~0.21 POL in USDC, so 0.3 POL
 *  (~$0.06) leaves room without being a budget. Another chain still needs
 *  AIFINPAY_MAX_GAS in its own currency: choosing the chain is explicit anyway. */
export const DEFAULT_MAX_GAS_POL = "0.3";

function ownerCeiling(name: string, raw: string | undefined, ceiling: number): number {
  if (raw === undefined || raw === "") return ceiling;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite owner limit`);
  if (value > ceiling) throw new Error(`${name} can only lower the built-in ceiling of ${ceiling}; set the working limits in the dashboard`);
  return value;
}

/** Signing is available only while payments are on and every spending boundary is set:
 *  the per-payment and daily USD ceiling, a gas cap, and an exact https allowlist when
 *  the owner chose to set one. */
export function validatePaymentConfig(config: McpConfig): bigint {
  if (!config.paymentsEnabled) throw new Error("Payments disabled by the owner (AIFINPAY_PAYMENTS_ENABLED=0)");
  const chain = payChain(config.payChain);
  if (config.devMode && chain.name !== "solana") throw new Error("MCP receipt payments support live mode only");
  if (config.rpcUrl !== undefined) {
    let rpc: URL | undefined;
    try {
      rpc = new URL(config.rpcUrl);
    } catch {
      rpc = undefined;
    }
    if (!rpc || rpc.protocol !== "https:" || rpc.username || rpc.password)
      throw new Error("AIFINPAY_RPC_URL must be an https URL without credentials");
  }
  for (const [name, value] of [
    ["AIFINPAY_MAX_USD", config.maxAmountUsd],
    ["AIFINPAY_DAILY_USD", config.dailyAmountUsd],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive finite owner limit`);
  }
  // Unset means "the origin of the URL being fetched" (see McpConfig). An empty
  // list is a config bug's shape, not a request for that default, and a
  // malformed entry would read as allowed while matching nothing.
  if (
    config.gatewayOrigins !== undefined &&
    (!config.gatewayOrigins.length ||
      config.gatewayOrigins.some((origin) => {
        try {
          const u = new URL(origin);
          return (
            u.protocol !== "https:" || u.origin !== origin || !!u.username || !!u.password || u.hostname.includes("*")
          );
        } catch {
          return true;
        }
      }))
  )
    throw new Error("AIFINPAY_GATEWAY_ORIGINS must list exact HTTPS origins; unset it to accept the origin of each URL");
  if (chain.name === "solana") {
    const expectedNetwork = config.devMode ? "devnet" : "mainnet";
    if (config.solanaNetwork !== expectedNetwork)
      throw new Error(`AIFINPAY_SOLANA_NETWORK must be ${expectedNetwork} for the configured AIFINPAY_MODE`);
    if (!config.rpcUrl) throw new Error("Solana payments require an explicit owner-trusted AIFINPAY_RPC_URL");
    if (config.maxGas !== undefined || config.maxGasPol !== undefined)
      throw new Error("Solana uses AIFINPAY_MAX_FEE_LAMPORTS for fees and rent; EVM gas caps do not apply");
    if (config.payAsset !== undefined && config.payAsset !== "SOL") {
      try {
        solanaStableMint(config.solanaNetwork, config.payAsset);
      } catch {
        throw new Error("AIFINPAY_PAY_ASSET is not pinned for the selected Solana network");
      }
    }
    const fee = config.maxFeeLamports;
    if (typeof fee !== "string" || !/^[1-9][0-9]*$/.test(fee) || BigInt(fee) > 2n ** 64n - 1n)
      throw new Error(
        "AIFINPAY_MAX_FEE_LAMPORTS must be a positive uint64 integer covering transaction fees and account rent"
      );
    return BigInt(fee);
  }
  if (config.solanaNetwork !== undefined || config.maxFeeLamports !== undefined)
    throw new Error("Solana network and lamport fee settings require AIFINPAY_PAY_CHAIN=solana");
  if (
    config.payAsset !== undefined &&
    config.payAsset !== chain.native &&
    !paymentStableAsset(chain.name, config.payAsset)
  )
    throw new Error(`AIFINPAY_PAY_ASSET must be "${chain.native}" or a stablecoin symbol pinned for ${chain.name}`);
  // The POL-named cap means POL. Read on another chain it would silently cap
  // ETH gas at a number chosen for POL — 0.3 POL is ~$0.04, 0.3 ETH is ~$800.
  if (config.maxGasPol !== undefined && chain.name !== "polygon")
    throw new Error(
      `AIFINPAY_MAX_GAS_POL caps POL gas and does not apply on ${chain.name}; set AIFINPAY_MAX_GAS in ${chain.native}`
    );
  if (config.maxGas !== undefined && config.maxGasPol !== undefined && config.maxGas !== config.maxGasPol)
    throw new Error("AIFINPAY_MAX_GAS and AIFINPAY_MAX_GAS_POL disagree; set one");
  const name = config.maxGas !== undefined || chain.name !== "polygon" ? "AIFINPAY_MAX_GAS" : "AIFINPAY_MAX_GAS_POL";
  const gas = config.maxGas ?? config.maxGasPol ?? (chain.name === "polygon" ? DEFAULT_MAX_GAS_POL : undefined);
  if (typeof gas !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(gas))
    throw new Error(
      `${name} must be a positive decimal with at most 18 places: the gas cap per payment in ${chain.native}`
    );
  const [whole, fraction = ""] = gas.split(".");
  const wei = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (wei <= 0n || wei >= 2n ** 256n) throw new Error(`${name} is outside the supported range`);
  return wei;
}
