import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolContext } from "../server.js";
import { DEFAULT_DAILY_USD, DEFAULT_MAX_GAS_POL, DEFAULT_MAX_USD, validatePaymentConfig, type McpConfig } from "../config.js";
import { independentNativeUsd } from "../native-price.js";
import { payChain, type PayChain } from "../pay-chains.js";
import { dashboardRefusal, dashboardSentence, readDashboardPolicy, type DashboardStatus } from "../dashboard-policy.js";

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

// Optional env the owner may add to narrow the defaults; none of it is needed
// for a first payment. init prints it as a reference and README "Optional
// overrides" shows the same block; a test keeps the two equal. The gas cap is a
// worst case at the current Polygon gas price, not the fee: 0.05 POL refused
// every payment at ~280 gwei, so the default is 0.3 POL.
export const PAYMENT_OVERRIDES = Object.freeze({
  AIFINPAY_GATEWAY_ORIGINS: "https://merchant.example",
  AIFINPAY_MAX_GAS_POL: "0.3",
});

/** How payments work with nothing set, for init's output and the tool text. */
export const PAYMENTS_DEFAULT_NOTE =
  `Payments are on by default within a built-in ceiling of $${DEFAULT_MAX_USD} per payment and $${DEFAULT_DAILY_USD} per 24 hours, ` +
  "only through a persistent wallet, only to merchants registered with AiFinPay via a quote signed by its backend; an unfunded wallet spends nothing. " +
  "AIFINPAY_MAX_USD and AIFINPAY_DAILY_USD can only lower that ceiling; AIFINPAY_PAYMENTS_ENABLED=0 turns payments off; " +
  "AIFINPAY_GATEWAY_ORIGINS, when set, is the only list of payable sites.";

/** Where the owner manages the working limits once the agent is claimed. */
export const CONTROLS_NOTE =
  "The working limits are the dashboard Controls: once the agent is linked with agent_claim_self, the owner sets the per-payment cap, daily cap, pause and allowed merchants at https://dash.aifinpay.io, and AiFinPay enforces them on every quote and payment; this server's ceiling applies underneath.";

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
  /** A value applies (built in or the owner's); false when nothing bounds this. */
  set: boolean;
  value?: string | number | string[];
  /** "default": the built-in value; "env": the owner lowered or set it. */
  source?: "default" | "env";
}

export interface PaymentSetupStatus {
  ready: boolean;
  wallet: { persistent: boolean; source: string; evm_address: string };
  payments_enabled: boolean;
  pay_chain: string;
  pay_asset: string;
  /** The built-in ceiling; the env limits below can only lower it. */
  ceiling: { max_usd: number; daily_usd: number };
  limits: { max_usd: Limit; daily_usd: Limit; gas_cap: Limit; origins: Limit };
  /** The first owner setting the server would refuse, if payments were enabled now. */
  config_error?: string;
  balance: { amount: string; asset: string; chain: string; rpc: string } | "unknown";
  balance_error?: string;
  /** What to fund a persistent wallet with, priced now; absent for an ephemeral wallet. */
  funding?: Funding;
  /** The owner's dashboard Controls, read with this wallet's own signature; absent for an
   *  ephemeral wallet, on Solana, and on payable_fetch's refusal (which contacts nothing). */
  dashboard?: DashboardStatus;
  next_step: string;
}

export interface Funding {
  address: string;
  chain: string;
  asset: string;
  batch_usd: number;
  /** The native/USD rate read for this answer; absent when no price source answered. */
  rate_usd?: number;
  rate_source?: string;
  rate_error?: string;
  /** The smallest batch at that rate. */
  batch_native?: string;
  /** The owner's gas cap, when set. */
  gas_cap?: string;
  /** batch_native plus gas_cap: the amount to fund, when both are known. */
  amount?: string;
  /** The sentence to give the owner. Names a number only when one was read. */
  advice: string;
}

export function paymentSetupStatusTool() {
  return {
    name: "payment_setup_status",
    description:
      "Read-only checklist for paying with payable_fetch: wallet (persistent or ephemeral), whether payments are on, the ceiling and each limit with its source (built-in default or the owner's env), the wallet's native balance on the pay chain when readable, the owner's dashboard Controls in `dashboard`, and next_step — exactly one instruction for the first unmet item. " +
      "First payment in five steps: (1) GET the resource and read its 402 (merchant, price, smallest batch); (2) call payment_setup_status; (3) no persistent wallet: run `npx @aifinpay/mcp init` without a terminal, put its printed env into the MCP client config, then call agent_reload (no restart: payments are on by default); (4) tell the owner the address and the amount in `funding` (the smallest batch at today's rate plus the gas cap; if no rate could be read, ask for the batch price in the native currency at today's rate plus the gas cap and name no number), and offer the dashboard link so the owner can claim the agent (agent_claim_self) and set the working limits in Controls; (5) payable_fetch the URL. " +
      PAYMENTS_DEFAULT_NOTE +
      " Moves nothing and signs no payment: for a persistent wallet it signs one short AiFinPay read statement to fetch the owner's Controls. Never asks the owner's limits from the model.",
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

/** A USD limit with its source: the owner's env when they set it, otherwise the
 *  built-in ceiling (a programmatic value equal to the ceiling counts as it). */
function usdLimit(config: McpConfig, env: string, value: number | undefined, ceiling: number): Limit {
  if (value === undefined) return { env, set: false };
  const source = config.ownerOverrides?.includes(env) || value !== ceiling ? "env" : "default";
  return { env, set: true, value, source };
}

function gasLimit(config: McpConfig, chain: PayChain): Limit {
  if (chain.name === "solana") return limit("AIFINPAY_MAX_FEE_LAMPORTS", config.maxFeeLamports);
  if (config.maxGas !== undefined) return { ...limit("AIFINPAY_MAX_GAS", config.maxGas), source: "env" };
  if (config.maxGasPol !== undefined) return { ...limit("AIFINPAY_MAX_GAS_POL", config.maxGasPol), source: "env" };
  // validatePaymentConfig applies the same default on Polygon; another chain names its own cap.
  if (chain.name === "polygon") return { env: "AIFINPAY_MAX_GAS_POL", set: true, value: DEFAULT_MAX_GAS_POL, source: "default" };
  return limit("AIFINPAY_MAX_GAS", undefined);
}

/** "the built-in ceiling" or which part of it the owner lowered. */
function ceilingWords(limits: PaymentSetupStatus["limits"]): string {
  const lowered = [limits.max_usd, limits.daily_usd].filter((l) => l.source === "env").map((l) => l.env);
  return lowered.length
    ? `the built-in $${DEFAULT_MAX_USD} / $${DEFAULT_DAILY_USD} ceiling, lowered by the owner's ${lowered.join(" and ")}`
    : "the built-in ceiling";
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
    max_usd: usdLimit(config, "AIFINPAY_MAX_USD", config.maxAmountUsd, DEFAULT_MAX_USD),
    daily_usd: usdLimit(config, "AIFINPAY_DAILY_USD", config.dailyAmountUsd, DEFAULT_DAILY_USD),
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
    ceiling: { max_usd: DEFAULT_MAX_USD, daily_usd: DEFAULT_DAILY_USD },
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
  // The amount to fund is answered whatever the env says: step 4 ("tell the
  // owner the address and the amount") must not wait on it, and the 2026-10-19
  // quote priced $0.10 at 1.08 POL while the guide still said 0.5 — no fixed
  // rate survives, so the tool reads one now.
  const gasCap =
    status.limits.gas_cap.set && Number(status.limits.gas_cap.value) > 0 ? String(status.limits.gas_cap.value) : undefined;
  const rpc = config.rpcUrl ?? chain.defaultRpc;
  if (options.readBalance && chain.name !== "solana") {
    status.funding = await funding(ctx, chain, rpc, gasCap);
    // The owner's Controls are the working limits once the agent is claimed;
    // read them here so the agent can name them, or offer the link if there is none.
    status.dashboard = await readDashboardPolicy(ctx);
  }
  const withDashboard = (text: string) =>
    status.dashboard ? `${text} ${dashboardSentence(status.dashboard)}` : text;
  // The env is read once, at start. An agent that saw agent_reload succeed and
  // payments stay off concluded the settings were lost, and stopped: say what
  // the owner changes and that the client must restart the server after.
  const restart =
    "Env is read only when the server starts and agent_reload does not read it: once the owner has saved the change, have the client restart the aifinpay MCP server (restart the client, or disable and re-enable the server), then call payment_setup_status again.";
  if (!config.paymentsEnabled) {
    status.next_step = withDashboard(
      `Payments are off: the owner set AIFINPAY_PAYMENTS_ENABLED=0 for this server (they are on by default, within ${ceilingWords(limits)}). ` +
        `To turn them on, the owner removes that variable from the server's env in the MCP client config. ${restart} ${CONTROLS_NOTE}`
    );
    return status;
  }
  if (configError) {
    status.next_step = withDashboard(
      `Owner setting refused: ${configError}. The owner fixes it in the server's env in the MCP client config. ` + restart
    );
    return status;
  }
  // Paused or expired Controls refuse every quote; funding or paying now would only fail.
  const refusal = status.dashboard && dashboardRefusal(status.dashboard);
  if (refusal) {
    status.next_step = refusal;
    return status;
  }
  if (status.funding) {
    try {
      const balance = await nativeBalance(ctx, rpc, ctx.agent.evmAddress);
      status.balance = { amount: formatNative(balance), asset: chain.native, chain: chain.name, rpc };
      const needed = status.funding.amount !== undefined ? Number(status.funding.amount) : Number(gasCap);
      if (Number(status.balance.amount) < needed) {
        status.next_step = withDashboard(
          status.funding.amount !== undefined
            ? `Fund ${ctx.agent.evmAddress} on ${chain.label} with about ${status.funding.amount} ${chain.native} (the smallest batch is $${SMALLEST_BATCH_USD.toFixed(2)} ≈ ${status.funding.batch_native} ${chain.native} at today's rate plus up to ${gasCap} ${chain.native} gas; it holds ${status.balance.amount}), then call payment_setup_status again.`
            : `Fund ${ctx.agent.evmAddress} on ${chain.label} with the batch price in ${chain.native} at today's rate plus the gas cap of ${gasCap} ${chain.native} (the rate could not be read here, so ask the owner to look it up; it holds ${status.balance.amount}), then call payment_setup_status again.`
        );
        return status;
      }
    } catch (error) {
      status.balance_error = `balance not read from ${rpc}: ${(error as Error).message}`;
    }
  }
  status.ready = true;
  const sites = config.gatewayOrigins?.length
    ? `on ${config.gatewayOrigins.join(" or ")}`
    : "on any https site (the owner can narrow this with AIFINPAY_GATEWAY_ORIGINS)";
  status.next_step = withDashboard(
    `Ready. Call payable_fetch({"url": "<HTTPS resource ${sites}>"}); ` +
      `it pays at most $${config.maxAmountUsd} per call and $${config.dailyAmountUsd} per 24 hours (${ceilingWords(limits)}), with gas capped at ${status.limits.gas_cap.value} ${chain.native}, and only merchants registered with AiFinPay are ever paid. ` +
      CONTROLS_NOTE +
      (status.balance === "unknown"
        ? ` The wallet must hold the batch price plus up to the gas cap in ${chain.native} on ${chain.label}` +
          (status.funding?.amount !== undefined ? ` (about ${status.funding.amount} ${chain.native} at today's rate).` : ".")
        : "")
  );
  return status;
}

/**
 * The amount to fund, priced now. Never a fixed rate: the number comes from
 * the same independent price sources payable_fetch uses, and when none
 * answers the advice says so and names no number, so the agent asks the owner
 * for "the batch price at today's rate plus the gas cap" instead of inventing one.
 */
async function funding(ctx: ToolContext, chain: PayChain, rpc: string, gasCap: string | undefined): Promise<Funding> {
  const address = ctx.agent.evmAddress;
  const base: Funding = {
    address,
    chain: chain.name,
    asset: chain.native,
    batch_usd: SMALLEST_BATCH_USD,
    ...(gasCap !== undefined ? { gas_cap: gasCap } : {}),
    advice: "",
  };
  const batch = `the smallest batch ($${SMALLEST_BATCH_USD.toFixed(2)})`;
  const cap = gasCap !== undefined ? `the gas cap of ${gasCap} ${chain.native}` : "the gas cap the owner sets";
  try {
    const price = await independentNativeUsd({
      fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
      chain,
      rpc,
    });
    const batchNative = SMALLEST_BATCH_USD / price.usd;
    const funded: Funding = {
      ...base,
      rate_usd: price.usd,
      rate_source: price.source,
      batch_native: formatAmount(batchNative, 4),
    };
    if (gasCap === undefined) {
      funded.advice = `Fund ${address} on ${chain.label} with ${batch} ≈ ${funded.batch_native} ${chain.native} at today's rate ($${formatAmount(price.usd, 4)}/${chain.native}) plus ${cap}.`;
      return funded;
    }
    funded.amount = formatAmount(batchNative + Number(gasCap), 2);
    funded.advice = `Fund ${address} on ${chain.label} with about ${funded.amount} ${chain.native}: ${batch} ≈ ${funded.batch_native} ${chain.native} at today's rate ($${formatAmount(price.usd, 4)}/${chain.native}) plus up to ${gasCap} ${chain.native} gas.`;
    return funded;
  } catch (error) {
    return {
      ...base,
      rate_error: (error as Error).message,
      advice: `The ${chain.native}/USD rate could not be read here, so name no amount: ask the owner to fund ${address} on ${chain.label} with the price of ${batch} in ${chain.native} at today's rate plus ${cap}.`,
    };
  }
}

/** Fixed decimals for readable amounts; more for ones that would round to zero (ETH on Base). */
function formatAmount(value: number, decimals: number): string {
  return value.toFixed(value >= 0.01 || value === 0 ? decimals : 6);
}

function unready(ctx: ToolContext, source: string, chain: PayChain, error: string): PaymentSetupStatus {
  return {
    ready: false,
    wallet: { persistent: source !== "ephemeral", source, evm_address: ctx.agent.evmAddress },
    payments_enabled: Boolean(ctx.config.paymentsEnabled),
    pay_chain: String(ctx.config.payChain),
    pay_asset: ctx.config.payAsset ?? chain.native,
    ceiling: { max_usd: DEFAULT_MAX_USD, daily_usd: DEFAULT_DAILY_USD },
    limits: {
      max_usd: usdLimit(ctx.config, "AIFINPAY_MAX_USD", ctx.config.maxAmountUsd, DEFAULT_MAX_USD),
      daily_usd: usdLimit(ctx.config, "AIFINPAY_DAILY_USD", ctx.config.dailyAmountUsd, DEFAULT_DAILY_USD),
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
