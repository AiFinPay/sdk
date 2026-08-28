/**
 * v1.3 splitter selection, keyed by chain AND protocol route.
 *
 * From v1.3 a chain carries one splitter per protocol route, because the fee
 * split is immutable at construction and the two protocols need different
 * economics:
 *
 *   merchant-aifp1 (100/0) — the agent pays the quoted gross amount, the
 *     AiFinPay treasury receives 1%, the merchant receives 99%.
 *   agent-x402 (0/0) — the provider receives 100% of the provider-defined
 *     price and the AiFinPay fee is 0% for now. This route is NOT fee-on-top;
 *     fee-on-top semantics arrive in a future contract version.
 *
 * Selection must use both chain and route, and must never fall back from one
 * route to the other. That is not a style preference. The splitters were
 * deployed with CREATE, so an address derives from deployer and nonce and the
 * same address recurs on other chains for the other route:
 *
 *   0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55
 *     is OP's merchant-aifp1 AND Base's agent-x402
 *   0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74
 *     is Unichain's merchant-aifp1, Avalanche's agent-x402, AND the legacy
 *     v1.2 splitter on Optimism
 *
 * An address on its own therefore says nothing about which economics apply.
 * Resolving by chain alone would settle at the wrong fee split, silently,
 * and the amounts would still look plausible in every log.
 *
 * The table itself is NOT in this file. It is generated into
 * splitterRoutes.generated.ts from registry/splitter-table.json, a byte-for-byte
 * copy of the canonical artifact in AiFinPay/evm-contract, where every
 * payment-critical field — splitter, owner, treasury, both bps values, the
 * runtime code hash — was read from the chain by verify-registry.mjs. Two
 * repositories hand-maintaining the same payout addresses is the failure this
 * split prevents; `npm run registry:check` fails CI if they disagree.
 *
 * What stays here is the part worth reading: the types, the errors, and the two
 * resolvers. Logic belongs in a reviewed file, not in a generated one.
 */
import type { Chain } from "viem/chains";

import { SPLITTER_ROUTES } from "./splitterRoutes.generated.js";

export {
  SPLITTER_ROUTES,
  SPLITTER_GOVERNANCE,
  SPLITTER_REGISTRY_SOURCE,
} from "./splitterRoutes.generated.js";

/** Protocol routes. A route is a fee profile fixed at construction. */
export type SplitterRoute = "merchant-aifp1" | "agent-x402";

/** Chains carrying v1.3 route splitters. */
export type SplitterRouteChain =
  | "polygon"
  | "optimism"
  | "bnb"
  | "unichain"
  | "botchain"
  | "base"
  | "arbitrum"
  | "avalanche"
  | "xrplevm";

/** Key into SPLITTER_ROUTES. Both halves are required. */
export type SplitterRouteKey = `${SplitterRouteChain}:${SplitterRoute}`;

export interface SplitterRouteDeployment {
  chain: SplitterRouteChain;
  route: SplitterRoute;
  chainId: number;
  viemChain: Chain;
  splitter: `0x${string}`;
  /**
   * The governance Safe, read from the contract's own owner(). It controls
   * pause/unpause, the treasury address and the stablecoin whitelist, so it is
   * carried here rather than assumed: every other field is only as trustworthy
   * as whoever can change it.
   */
  owner: `0x${string}`;
  /** Owner and treasury are the same governance Safe on every chain. */
  treasury: `0x${string}`;
  /** Immutable, baked into runtime code. 100 = 1%. */
  treasuryBps: number;
  ipCreatorBps: number;
  /** keccak-256 of the deployed runtime bytecode, read from chain. */
  runtimeCodeHash: `0x${string}`;
  /**
   * Deployed and verified is not the same as payable. A route is enabled
   * individually, and only after a successful mainnet paid end-to-end
   * settlement on that exact route with verified balance deltas.
   */
  settlementEnabled: boolean;
  /**
   * How many independent RPC providers agreed on every field above when the
   * registry was verified. A route verified from one provider can never be
   * enabled — BOT Chain and XRPL EVM have exactly one public provider each.
   */
  rpcQuorum: number;
  /**
   * Stablecoins the splitter accepts, read live via whitelistedTokens() and
   * owner-mutable, so pinned separately from the runtime hash. null = not
   * accepted on this chain; a chain with both null settles native only.
   */
  stablecoins: { USDC: `0x${string}` | null; USDT: `0x${string}` | null };
  /** Policy review window. Outside it, a route must not settle. */
  validFrom: string;
  validUntil: string;
  defaultRpc: string;
  explorer: string;
  /** The date the fields above were last read from the chain. */
  verifiedAt: string;
}

export class UnknownSplitterRouteError extends Error {
  constructor(chain: string, route: string) {
    super(
      `No v1.3 splitter registered for ${chain}:${route}. Supported: ` +
        `${Object.keys(SPLITTER_ROUTES).join(", ")}. There is deliberately no ` +
        `fallback between routes — merchant-aifp1 and agent-x402 have different ` +
        `immutable fee splits, so substituting one for the other would settle ` +
        `at the wrong amount.`,
    );
    this.name = "UnknownSplitterRouteError";
  }
}

export class SplitterRouteNotSettlingError extends Error {
  constructor(key: string, reason: string) {
    super(`Splitter route ${key} must not settle: ${reason}`);
    this.name = "SplitterRouteNotSettlingError";
  }
}

/**
 * Resolve a splitter by chain AND route. Throws on an unknown pair rather
 * than falling back, because the fallback is the bug: every route resolves to
 * a real, deployed, working contract with the wrong economics.
 */
export function resolveSplitterRoute(
  chain: SplitterRouteChain | string,
  route: SplitterRoute | string,
): SplitterRouteDeployment {
  const entry = (SPLITTER_ROUTES as Partial<Record<string, SplitterRouteDeployment>>)[
    `${chain}:${route}`
  ];
  if (!entry) throw new UnknownSplitterRouteError(String(chain), String(route));
  return entry;
}

/**
 * Resolve a route that is cleared to move money. Separate from
 * resolveSplitterRoute on purpose: reading the registry and being allowed to
 * settle are different questions, and conflating them is how a disabled route
 * ends up paying.
 */
export function resolveSettlingSplitterRoute(
  chain: SplitterRouteChain | string,
  route: SplitterRoute | string,
  now: Date = new Date(),
): SplitterRouteDeployment {
  const entry = resolveSplitterRoute(chain, route);
  const key = `${entry.chain}:${entry.route}`;
  if (!entry.settlementEnabled) {
    throw new SplitterRouteNotSettlingError(
      key,
      "settlement is not enabled for this route yet — it is enabled only after a " +
        "successful mainnet paid end-to-end settlement with verified balance deltas",
    );
  }
  // Every comparison below is written as "prove it is inside the window", never
  // "prove it is outside". With `t < from` / `t >= until`, one malformed date
  // parses to NaN, both comparisons are false, and the route settles with no
  // time gate at all — the gate fails OPEN on exactly the input you cannot
  // trust. Requiring the positive fact instead means NaN fails every check.
  const from = Date.parse(entry.validFrom);
  const until = Date.parse(entry.validUntil);
  const t = now.getTime();

  if (!Number.isFinite(from) || !Number.isFinite(until)) {
    throw new SplitterRouteNotSettlingError(
      key,
      `its policy window is unreadable (validFrom ${entry.validFrom}, validUntil ` +
        `${entry.validUntil}) — a window that cannot be parsed is not a window that has opened`,
    );
  }
  if (!Number.isFinite(t)) {
    throw new SplitterRouteNotSettlingError(
      key,
      "the current time was passed as an invalid Date, so the policy window cannot be evaluated",
    );
  }
  if (from >= until) {
    throw new SplitterRouteNotSettlingError(
      key,
      `its policy window is inverted (validFrom ${entry.validFrom} is not before ` +
        `validUntil ${entry.validUntil})`,
    );
  }
  if (!(t >= from)) {
    throw new SplitterRouteNotSettlingError(key, `its policy window opens ${entry.validFrom}`);
  }
  if (!(t < until)) {
    throw new SplitterRouteNotSettlingError(
      key,
      `its policy window expired ${entry.validUntil} and has not been re-reviewed`,
    );
  }
  return entry;
}
