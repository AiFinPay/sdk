/**
 * B2BSplitter v1.4 settlement — the client half.
 *
 * v1.4 inverts who authorises a payment. Through v1.3 the agent built its own
 * calldata and settled unilaterally; the backend verified afterwards. In v1.4
 * both entrypoints go through `_verifyQuote`, which requires a 65-byte ECDSA
 * signature from a SIGN_OPERATOR_ROLE holder. The agent cannot produce one, so
 * the quote arrives already signed and the agent's job is to CHECK it and
 * submit it — never to construct it.
 *
 * That makes this module mostly refusals, and deliberately so. Spec:
 * evm-contract@feat/v14_migration docs/V14_QUOTE_FORMAT.md §8, "SDK / Frontend
 * Responsibilities". Each check below cites the clause it implements, because
 * a check nobody can trace back to a requirement is a check somebody deletes.
 */
import {
  keccak256, stringToHex, parseAbi,
  type PublicClient, type WalletClient, type Address, type Hex,
} from "viem";

/** The Quote struct, exactly as B2BSplitterV14 declares it. Field ORDER is part
 *  of the EIP-712 hash — this mirrors _QUOTE_TYPEHASH and must not be reordered. */
export interface V14Quote {
  payer:       Address;
  merchant:    Address;
  token:       Address;   // address(0) = native
  grossAmount: string;    // decimal wei / minor units
  ipCreator:   Address;
  validUntil:  string;    // unix seconds
  orderIdHash: Hex;
  nonce:       string;
  routeId:     Hex;
}

/** What `/v1/quote` returns under `settlement_call` when settlement_version is 1.4. */
export interface V14SettlementCall {
  chain:             string;
  contract:          Address;
  splitter_version:  "1.4";
  route:             string;
  asset:             string;
  function:          string;
  arg_encoding:      "struct+signature";
  field_order:       string[];
  value_wei:         string;
  args:              { quote: V14Quote; signature: Hex };
  bound_to_payer?:   Address;
  nonce_at_signing?: string;
}

export class V14SettlementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "V14SettlementError";
    this.code = code;
  }
}

/**
 * Routes this SDK understands, by NAME.
 *
 * §8.7 requires an allow-list and says old SDKs must refuse routes added after
 * they shipped rather than guess. Names rather than hashes because the contract
 * derives one from the other — Profiles.routeId(name) == keccak256(bytes(name)),
 * verified against the deployed Amoy Profiles on 2026-09-02 for both entries —
 * so hardcoding the hashes would be storing a derived value and inviting the
 * two to disagree.
 */
export const KNOWN_V14_ROUTES = ["merchant-aifp1", "agent-x402"] as const;
export type KnownV14Route = (typeof KNOWN_V14_ROUTES)[number];

export function routeIdOf(name: string): Hex {
  return keccak256(stringToHex(name));
}

/** name → routeId, for every route this SDK will submit. */
export function knownRouteIds(): Record<Hex, KnownV14Route> {
  const out: Record<string, KnownV14Route> = {};
  for (const n of KNOWN_V14_ROUTES) out[routeIdOf(n).toLowerCase()] = n;
  return out as Record<Hex, KnownV14Route>;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (s: string) => String(s || "").toLowerCase();

export interface V14ValidateOptions {
  /** The off-chain order id, when the caller knows it (§8.3). Omitted means the
   *  orderIdHash cannot be checked, and this module says so rather than
   *  pretending it verified something. */
  orderId?: string;
  /** The wallet that will send the transaction. §8.2 and the contract's own
   *  `payer == msg.sender` make this the difference between a quote that
   *  settles and one that reverts after gas. */
  payer?: Address;
  /** Seconds of headroom required before validUntil. A quote that expires while
   *  the transaction is in the mempool reverts SignatureExpired and the agent
   *  pays for the attempt. */
  minSecondsRemaining?: number;
  nowMs?: number;
  /** Extra route names this deployment understands. Additive only. */
  allowRoutes?: readonly string[];
}

/**
 * Every check §8 requires, before anything is broadcast.
 *
 * Throws on the first failure with a code, because these are not equivalent:
 * an expired quote should be re-requested, a foreign payer is a caller bug, and
 * an unknown route means this SDK is older than the deployment.
 */
export function validateV14SettlementCall(
  call: V14SettlementCall,
  opts: V14ValidateOptions = {},
): { route: string; expiresInSeconds: number; orderIdChecked: boolean } {
  const fail = (code: string, msg: string) => { throw new V14SettlementError(code, msg); };

  if (!call || typeof call !== "object") fail("V14_MALFORMED", "no settlement call");
  if (call.splitter_version !== "1.4") {
    fail("V14_WRONG_VERSION",
      `expected a v1.4 settlement call, got ${String(call.splitter_version)} — v1.2 and v1.3 settle through a different path`);
  }
  const q = call.args && call.args.quote;
  const sig = call.args && call.args.signature;
  if (!q || !sig) fail("V14_MALFORMED", "settlement call carries no quote or no signature");

  // §8.1 — the signature is the whole point. The contract requires exactly 65
  // bytes and reverts InvalidSignatureLength on anything else, after gas.
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    fail("V14_BAD_SIGNATURE", `signature must be 65 bytes, got ${(String(sig).length - 2) / 2}`);
  }

  // §8.7 — refuse routes this SDK does not understand rather than submit blind.
  const allowed = { ...knownRouteIds() } as Record<string, string>;
  for (const extra of opts.allowRoutes || []) allowed[routeIdOf(extra).toLowerCase()] = extra;
  const route = allowed[lc(q.routeId)];
  if (!route) {
    fail("V14_UNKNOWN_ROUTE",
      `routeId ${q.routeId} is not one this SDK understands (${Object.values(allowed).join(", ")}). ` +
      `A route added after this SDK shipped is expected — upgrade rather than force it.`);
  }

  // §8.2 — the contract enforces payer == msg.sender. Catching it here costs
  // nothing; catching it on-chain costs the gas of a reverted transaction.
  if (opts.payer && lc(opts.payer) !== lc(q.payer)) {
    fail("V14_WRONG_PAYER",
      `this quote is signed for ${q.payer} and cannot be settled by ${opts.payer} — request one for your own address`);
  }
  if (call.bound_to_payer && lc(call.bound_to_payer) !== lc(q.payer)) {
    fail("V14_MALFORMED", "bound_to_payer disagrees with the signed quote — do not submit this");
  }

  // §8.3 — hash the order id locally and compare. This is what stops a backend
  // (or anything between it and here) from binding your payment to a different
  // order than the one you asked about.
  let orderIdChecked = false;
  if (opts.orderId !== undefined) {
    if (lc(keccak256(stringToHex(opts.orderId))) !== lc(q.orderIdHash)) {
      fail("V14_ORDER_MISMATCH",
        `this quote settles a different order: orderIdHash does not match keccak256("${opts.orderId}")`);
    }
    orderIdChecked = true;
  }

  // §8.4 — expiry. Checked with headroom, because the relevant moment is when
  // the transaction is MINED, not when it is signed.
  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const expiresIn = Number(BigInt(q.validUntil) - BigInt(now));
  const need = opts.minSecondsRemaining ?? 30;
  if (expiresIn <= 0) {
    fail("V14_EXPIRED", `quote expired ${-expiresIn}s ago — request a fresh one, do not submit this`);
  }
  if (expiresIn < need) {
    fail("V14_EXPIRING",
      `quote expires in ${expiresIn}s, less than the ${need}s of headroom required — ` +
      `it would likely revert SignatureExpired after you have paid gas`);
  }

  // §8.5 — msg.value must equal grossAmount exactly for native. The contract
  // reverts IncorrectNativeValue on any difference, in either direction.
  if (lc(q.token) === ZERO && String(call.value_wei) !== String(q.grossAmount)) {
    fail("V14_VALUE_MISMATCH",
      `value_wei (${call.value_wei}) must equal the signed grossAmount (${q.grossAmount})`);
  }

  return { route: route as string, expiresInSeconds: expiresIn, orderIdChecked };
}

const NONCE_ABI = parseAbi([
  "function consumedNonce(address,uint256) view returns (bool)",
  "function payerNonce(address) view returns (uint256)",
  "function paused() view returns (bool)",
]);

/**
 * §8.6 — never re-broadcast a settled quote.
 *
 * The contract keeps two things and they answer different questions:
 *   consumedNonce[payer][nonce]  has THIS nonce already been spent
 *   payerNonce[payer]            which nonce the contract will accept next
 *
 * A quote is submittable only if its nonce is unspent AND is the one the
 * contract expects. Two outstanding quotes for one wallet cannot both settle:
 * the second carries a stale nonce and reverts InvalidNonce. That is a property
 * of the contract, so it is reported here rather than discovered on-chain.
 */
export async function checkV14Submittable(
  publicClient: PublicClient,
  call: V14SettlementCall,
): Promise<{ submittable: true } | { submittable: false; reason: string; code: string }> {
  const q = call.args.quote;
  const [spent, expected, paused] = await Promise.all([
    publicClient.readContract({ address: call.contract, abi: NONCE_ABI, functionName: "consumedNonce", args: [q.payer, BigInt(q.nonce)] }),
    publicClient.readContract({ address: call.contract, abi: NONCE_ABI, functionName: "payerNonce", args: [q.payer] }),
    publicClient.readContract({ address: call.contract, abi: NONCE_ABI, functionName: "paused" }),
  ]);

  if (paused) {
    return { submittable: false, code: "V14_PAUSED",
      reason: "the splitter is paused — every settlement reverts until it is unpaused" };
  }
  if (spent) {
    return { submittable: false, code: "V14_ALREADY_SETTLED",
      reason: `nonce ${q.nonce} has already been spent by ${q.payer} — this quote is settled, do not pay twice` };
  }
  if (BigInt(expected) !== BigInt(q.nonce)) {
    return { submittable: false, code: "V14_STALE_NONCE",
      reason: `this quote was signed at nonce ${q.nonce} but the contract now expects ${expected} — ` +
              `another payment from this wallet settled first; request a fresh quote` };
  }
  return { submittable: true };
}

const SETTLE_ABI = parseAbi([
  "function settleNative((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote, bytes signature) payable",
  "function settleStable((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote, bytes signature)",
]);

const asTuple = (q: V14Quote) => ({
  payer: q.payer, merchant: q.merchant, token: q.token,
  grossAmount: BigInt(q.grossAmount), ipCreator: q.ipCreator,
  validUntil: BigInt(q.validUntil), orderIdHash: q.orderIdHash,
  nonce: BigInt(q.nonce), routeId: q.routeId,
});

/**
 * Validate, check submittability, then send.
 *
 * The order matters and is not stylistic: every check that can be made without
 * the chain runs before the one that costs a round trip, and all of them run
 * before anything is broadcast. Once `writeContract` is called the agent has
 * spent gas whatever happens next.
 */
export async function executeV14Settlement(
  call: V14SettlementCall,
  ctx: {
    publicClient: PublicClient;
    walletClient: WalletClient;
    account: Address;
    orderId?: string;
    minSecondsRemaining?: number;
    /** Skip the on-chain pre-flight. Only for a caller that has just done it. */
    skipPreflight?: boolean;
  },
): Promise<{ hash: Hex; route: string }> {
  const { route } = validateV14SettlementCall(call, {
    orderId: ctx.orderId, payer: ctx.account, minSecondsRemaining: ctx.minSecondsRemaining,
  });

  if (!ctx.skipPreflight) {
    const pre = await checkV14Submittable(ctx.publicClient, call);
    if (!pre.submittable) throw new V14SettlementError(pre.code, pre.reason);
  }

  const q = call.args.quote;
  const native = lc(q.token) === ZERO;
  if (!native) {
    // §9.1 — settleStable needs an allowance first. Refused rather than
    // silently attempted: approving on the agent's behalf is a decision the
    // agent's own policy layer makes, not this function.
    throw new V14SettlementError("V14_STABLE_NOT_SUPPORTED",
      "stablecoin settlement requires approve(splitter, grossAmount) first and is not yet wired here — " +
      "quote in native for now");
  }

  const hash = await ctx.walletClient.writeContract({
    address: call.contract,
    abi: SETTLE_ABI,
    functionName: "settleNative",
    args: [asTuple(q), call.args.signature],
    value: BigInt(q.grossAmount),
    account: ctx.account,
    chain: null,
  });
  return { hash, route };
}
