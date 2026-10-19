import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolContext } from "../server.js";
import { validatePaymentConfig, type McpConfig } from "../config.js";
import { independentNativeUsd } from "../native-price.js";
import { payChain, type PayChain } from "../pay-chains.js";

/**
 * The one read-only checklist between "server connected" and "first payment".
 *
 * A fresh agent (Codex + MCP 2.10.0, 2026-10-19) was told it could pay $0.10
 * and never did: tools/list showed no payment tool, every start minted a new
 * ephemeral wallet, and nothing said which of the owner settings was missing.
 * This tool answers all of that at once and names exactly one next step, so
 * the agent never has to guess the order. It signs nothing and writes nothing;
 * its only network traffic is an optional balance read over the pay chain's
 * RPC, and only for a persistent wallet (an ephemeral balance is meaningless).
 */

/** The smallest AIFP-1 batch the backend sells, in USD. */
export const SMALLEST_BATCH_USD = 0.1;

// The owner settings that let payable_fetch sign, as init prints them. README
// "Enable native paid GET requests" shows the same block; a test keeps the two
// equal and starts a server with it. The gas cap is a worst case at the current
// Polygon gas price, not the fee: 0.05 POL refused every payment at ~280 gwei.
export const PAYMENT_ENV = Object.freeze({
  AIFINPAY_PAYMENTS_ENABLED: "1",
  AIFINPAY_GATEWAY_ORIGINS: "https://merchant.example",
  AIFINPAY_GATEWAY_PATH_MODE: "direct",
  AIFINPAY_MAX_USD: "0.15",
  AIFINPAY_DAILY_USD: "1.00",
  AIFINPAY_MAX_GAS_POL: "0.3",
});

export const INIT_COMMAND = "npx @aifinpay/mcp init";

/** POSIX single quotes: the path reaches init byte for byte, spaces and quotes included. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * init, run so that it writes the keystore this server reads. An agent's shell
 * does not have the server's AIFINPAY_HOME, so a bare `npx @aifinpay/mcp init`
 * wrote ~/.aifinpay/agent.json while the server kept looking elsewhere.
 */
export function initCommand(walletHome: string | undefined): string {
  return walletHome ? `AIFINPAY_HOME=${shellQuote(resolve(walletHome))} ${INIT_COMMAND}` : INIT_COMMAND;
}

/** A directory that does not exist yet, for a new wallet beside one that cannot be opened. */
export function freshWalletHome(now: Date = new Date()): string {
  const base = join(homedir(), ".aifinpay", `agent-${now.toISOString().slice(0, 10).replace(/-/g, "")}`);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * The way past an encrypted keystore nobody here can open. init and the server
 * both refuse to replace it, rightly: it may hold funds. Without this the agent
 * had a refusal and no next move, and the next move it invented was its own key
 * handling. A new, empty AIFINPAY_HOME leaves the old file untouched.
 */
export function lockedKeystoreStep(keystore: string): string {
  return (
    `${keystore} is an encrypted wallet that cannot be opened here: AIFINPAY_WALLET_PASSPHRASE is not set or is wrong. ` +
    `Do not delete, move or overwrite it; it may hold funds. ` +
    `If its passphrase is known, set AIFINPAY_WALLET_PASSPHRASE in the aifinpay server's env in the MCP client config and reconnect. ` +
    `Otherwise create a new wallet in a new, empty directory: run \`${initCommand(freshWalletHome())}\`, ` +
    `put the "env" it prints (it includes AIFINPAY_HOME) into the aifinpay server's env in the MCP client config, ` +
    `reconnect the server, then call agent_reload and payment_setup_status again.`
  );
}

/** The keystore this server reads, when it is encrypted and the server has no passphrase for it. */
function lockedKeystore(config: McpConfig): string | undefined {
  if (config.walletPassphrase) return undefined;
  const keystore = join(resolve(config.walletHome || join(homedir(), ".aifinpay")), "agent.json");
  try {
    return JSON.parse(readFileSync(keystore, "utf8"))?.enc ? keystore : undefined;
  } catch {
    return undefined;
  }
}

interface Limit {
  env: string;
  set: boolean;
  value?: string | number | string[];
}

export interface PaymentSetupStatus {
  ready: boolean;
  wallet: { persistent: boolean; source: string; evm_address: string };
  payments_enabled: boolean;
  pay_chain: string;
  pay_asset: string;
  limits: { max_usd: Limit; daily_usd: Limit; gas_cap: Limit; origins: Limit };
  /** The first owner setting the server would refuse, if payments were enabled now. */
  config_error?: string;
  balance: { amount: string; asset: string; chain: string; rpc: string } | "unknown";
  balance_error?: string;
  next_step: string;
}

export function paymentSetupStatusTool() {
  return {
    name: "payment_setup_status",
    description:
      "Read-only checklist for paying with payable_fetch: wallet (persistent or ephemeral), whether the owner enabled payments, which owner limits are set, the wallet's native balance on the pay chain when readable, and next_step — exactly one instruction for the first unmet item. " +
      "First payment in five steps: (1) GET the resource and read its 402 (merchant, price, smallest batch); (2) call payment_setup_status; (3) no persistent wallet: run `npx @aifinpay/mcp init` without a terminal, put its printed env into the MCP client config, reconnect, agent_reload; (4) tell the owner the address and the amount to fund, and have the owner add the payment env (AIFINPAY_PAYMENTS_ENABLED=1, origins, USD limits, gas cap) and reconnect; (5) payable_fetch the URL. " +
      "Signs nothing, moves nothing, never asks the owner's limits from the model.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
  };
}

export async function runPaymentSetupStatus(ctx: ToolContext, _args: Record<string, unknown>) {
  const status = await paymentSetupStatus(ctx, { readBalance: true });
  return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
}

function limit(env: string, value: string | number | string[] | undefined): Limit {
  return value === undefined ? { env, set: false } : { env, set: true, value };
}

function gasLimit(config: McpConfig, chain: PayChain): Limit {
  if (chain.name === "solana") return limit("AIFINPAY_MAX_FEE_LAMPORTS", config.maxFeeLamports);
  if (config.maxGas !== undefined) return limit("AIFINPAY_MAX_GAS", config.maxGas);
  return limit(chain.name === "polygon" ? "AIFINPAY_MAX_GAS_POL" : "AIFINPAY_MAX_GAS", config.maxGasPol);
}

/** The example block, with the owner's real origins kept when they already set some. */
export function paymentEnvFor(config: McpConfig): Record<string, string> {
  return {
    ...PAYMENT_ENV,
    ...(config.gatewayOrigins?.length ? { AIFINPAY_GATEWAY_ORIGINS: config.gatewayOrigins.join(",") } : {}),
    ...(config.maxAmountUsd !== undefined ? { AIFINPAY_MAX_USD: String(config.maxAmountUsd) } : {}),
    ...(config.dailyAmountUsd !== undefined ? { AIFINPAY_DAILY_USD: String(config.dailyAmountUsd) } : {}),
  };
}

export async function paymentSetupStatus(
  ctx: ToolContext,
  options: { readBalance: boolean }
): Promise<PaymentSetupStatus> {
  const { config } = ctx;
  // The server names the identity it loaded; a context built without one is
  // persistent only when it carries the journal a persistent wallet gets.
  const source = ctx.walletSource ?? (ctx.paymentState ? "configured" : "ephemeral");
  const persistent = source !== "ephemeral";
  let chain: PayChain;
  try {
    chain = payChain(config.payChain);
  } catch (error) {
    chain = payChain(undefined);
    return unready(ctx, source, chain, (error as Error).message);
  }
  const limits = {
    max_usd: limit("AIFINPAY_MAX_USD", config.maxAmountUsd),
    daily_usd: limit("AIFINPAY_DAILY_USD", config.dailyAmountUsd),
    gas_cap: gasLimit(config, chain),
    origins: limit("AIFINPAY_GATEWAY_ORIGINS", config.gatewayOrigins),
  };
  // Validation is the server's own, run as if payments were enabled: it names
  // the first limit the server would refuse instead of just "disabled".
  let configError: string | undefined;
  try {
    validatePaymentConfig({ ...config, paymentsEnabled: true });
  } catch (error) {
    configError = (error as Error).message;
  }
  const status: PaymentSetupStatus = {
    ready: false,
    wallet: { persistent, source, evm_address: ctx.agent.evmAddress },
    payments_enabled: Boolean(config.paymentsEnabled),
    pay_chain: chain.name,
    pay_asset: config.payAsset ?? chain.native,
    limits,
    ...(configError ? { config_error: configError } : {}),
    balance: "unknown",
    next_step: "",
  };
  if (!persistent) {
    const locked = lockedKeystore(config);
    status.next_step =
      `No persistent wallet: this server started with an ephemeral one — do not fund ${ctx.agent.evmAddress}. ` +
      (locked
        ? lockedKeystoreStep(locked)
        : `Run \`${initCommand(config.walletHome)}\` (without a terminal it prints JSON; copy its "env" into this server's env in the MCP client config), reconnect the server, then call agent_reload and payment_setup_status again.`);
    return status;
  }
  if (!config.paymentsEnabled || configError) {
    const block = JSON.stringify(paymentEnvFor(config));
    status.next_step =
      (configError && config.paymentsEnabled
        ? `Owner setting refused: ${configError}. `
        : `Payments are off until the owner enables them. `) +
      `Have the owner add this to the server's env in the MCP client config (their real site origin and limits, not the example), then reconnect: ${block}` +
      (configError && !config.paymentsEnabled ? ` Currently missing: ${configError}` : "");
    return status;
  }
  const gasCap = Number(status.limits.gas_cap.value);
  if (options.readBalance && chain.name !== "solana") {
    const rpc = config.rpcUrl ?? chain.defaultRpc;
    try {
      const balance = await nativeBalance(ctx, rpc, ctx.agent.evmAddress);
      status.balance = { amount: formatNative(balance), asset: chain.native, chain: chain.name, rpc };
      const price = await independentNativeUsd({
        fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
        chain,
        rpc,
      }).catch(() => undefined);
      const batchNative = price ? SMALLEST_BATCH_USD / price.usd : 0;
      const needed = batchNative + gasCap;
      if (Number(status.balance.amount) < needed) {
        status.next_step =
          `Fund ${ctx.agent.evmAddress} on ${chain.label} with about ${needed.toFixed(2)} ${chain.native}` +
          (price
            ? ` (the smallest batch is $${SMALLEST_BATCH_USD.toFixed(2)} ≈ ${batchNative.toFixed(4)} ${chain.native} plus up to ${gasCap} ${chain.native} gas; it holds ${status.balance.amount})`
            : ` (at least the gas cap of ${gasCap} ${chain.native} plus the batch price; it holds ${status.balance.amount})`) +
          `, then call payment_setup_status again.`;
        return status;
      }
    } catch (error) {
      status.balance_error = `balance not read from ${rpc}: ${(error as Error).message}`;
    }
  }
  status.ready = true;
  status.next_step =
    `Ready. Call payable_fetch({"url": "<HTTPS resource on ${config.gatewayOrigins!.join(" or ")}>"}); ` +
    `it pays at most $${config.maxAmountUsd} per call and $${config.dailyAmountUsd} per 24 hours, with gas capped at ${status.limits.gas_cap.value} ${chain.native}.` +
    (status.balance === "unknown"
      ? ` The wallet must hold the batch price plus up to the gas cap in ${chain.native} on ${chain.label}.`
      : "");
  return status;
}

function unready(ctx: ToolContext, source: string, chain: PayChain, error: string): PaymentSetupStatus {
  return {
    ready: false,
    wallet: { persistent: source !== "ephemeral", source, evm_address: ctx.agent.evmAddress },
    payments_enabled: Boolean(ctx.config.paymentsEnabled),
    pay_chain: String(ctx.config.payChain),
    pay_asset: ctx.config.payAsset ?? chain.native,
    limits: {
      max_usd: limit("AIFINPAY_MAX_USD", ctx.config.maxAmountUsd),
      daily_usd: limit("AIFINPAY_DAILY_USD", ctx.config.dailyAmountUsd),
      gas_cap: limit("AIFINPAY_MAX_GAS", ctx.config.maxGas),
      origins: limit("AIFINPAY_GATEWAY_ORIGINS", ctx.config.gatewayOrigins),
    },
    config_error: error,
    balance: "unknown",
    next_step: `Owner setting refused: ${error}. The owner fixes AIFINPAY_PAY_CHAIN in the MCP client config and reconnects.`,
  };
}

/** eth_getBalance over the pay chain's RPC: a read, through the same guarded fetch as every other request. */
async function nativeBalance(ctx: ToolContext, rpc: string, address: string): Promise<bigint> {
  const response = await ctx.agent.inner.fetchImpl(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
    signal: AbortSignal.timeout(ctx.config.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result))
    throw new Error(body.error?.message ?? "malformed eth_getBalance result");
  return BigInt(body.result);
}

function formatNative(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fraction}`;
}
