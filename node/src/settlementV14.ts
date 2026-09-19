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
  keccak256,
  stringToHex,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  decodeEventLog,
  recoverTypedDataAddress,
  isAddress,
  type PublicClient,
  type WalletClient,
  type Address,
  type Hex,
} from "viem";

import { V14_DEPLOYMENTS } from "./generated/v14Deployments.generated.js";
import { SettlementConfirmationPendingError } from "./settlement.js";

/** The Quote struct, exactly as B2BSplitterV14 declares it. Field ORDER is part
 *  of the EIP-712 hash — this mirrors _QUOTE_TYPEHASH and must not be reordered. */
export interface V14Quote {
  payer: Address;
  merchant: Address;
  token: Address; // address(0) = native
  grossAmount: string; // decimal wei / minor units
  ipCreator: Address;
  validUntil: string; // unix seconds
  orderIdHash: Hex;
  nonce: string;
  routeId: Hex;
}

/** What `/v1/quote` returns under `settlement_call` when settlement_version is 1.4. */
export interface V14SettlementCall {
  chain: string;
  contract: Address;
  splitter_version: "1.4";
  route: string;
  asset: string;
  function: string;
  arg_encoding: "struct+signature";
  field_order: string[];
  value_wei: string;
  args: { quote: V14Quote; signature: Hex };
  bound_to_payer?: Address;
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
 * Read-only structural checks. Success does not authenticate the signer,
 * deployment, fees or treasury and does not authorize settlement.
 *
 * Throws on the first failure with a code, because these are not equivalent:
 * an expired quote should be re-requested, a foreign payer is a caller bug, and
 * an unknown route means this SDK is older than the deployment.
 */
export function validateV14SettlementCall(
  call: V14SettlementCall,
  opts: V14ValidateOptions = {}
): { route: string; expiresInSeconds: number; orderIdChecked: boolean } {
  const fail = (code: string, msg: string) => {
    throw new V14SettlementError(code, msg);
  };

  if (!call || typeof call !== "object") fail("V14_MALFORMED", "no settlement call");
  if (call.splitter_version !== "1.4") {
    fail(
      "V14_WRONG_VERSION",
      `expected a v1.4 settlement call, got ${String(call.splitter_version)} — v1.2 and v1.3 settle through a different path`
    );
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
    fail(
      "V14_UNKNOWN_ROUTE",
      `routeId ${q.routeId} is not one this SDK understands (${Object.values(allowed).join(", ")}). ` +
        `A route added after this SDK shipped is expected — upgrade rather than force it.`
    );
  }

  // §8.2 — the contract enforces payer == msg.sender. Catching it here costs
  // nothing; catching it on-chain costs the gas of a reverted transaction.
  if (opts.payer && lc(opts.payer) !== lc(q.payer)) {
    fail(
      "V14_WRONG_PAYER",
      `this quote is signed for ${q.payer} and cannot be settled by ${opts.payer} — request one for your own address`
    );
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
      fail(
        "V14_ORDER_MISMATCH",
        `this quote settles a different order: orderIdHash does not match keccak256("${opts.orderId}")`
      );
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
    fail(
      "V14_EXPIRING",
      `quote expires in ${expiresIn}s, less than the ${need}s of headroom required — ` +
        `it would likely revert SignatureExpired after you have paid gas`
    );
  }

  // §8.5 — msg.value must equal grossAmount exactly for native. The contract
  // reverts IncorrectNativeValue on any difference, in either direction.
  if (lc(q.token) === ZERO && String(call.value_wei) !== String(q.grossAmount)) {
    fail("V14_VALUE_MISMATCH", `value_wei (${call.value_wei}) must equal the signed grossAmount (${q.grossAmount})`);
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
  call: V14SettlementCall
): Promise<{ submittable: true } | { submittable: false; reason: string; code: string }> {
  const q = call.args.quote;
  const [spent, expected, paused] = await Promise.all([
    publicClient.readContract({
      address: call.contract,
      abi: NONCE_ABI,
      functionName: "consumedNonce",
      args: [q.payer, BigInt(q.nonce)],
    }),
    publicClient.readContract({
      address: call.contract,
      abi: NONCE_ABI,
      functionName: "payerNonce",
      args: [q.payer],
    }),
    publicClient.readContract({ address: call.contract, abi: NONCE_ABI, functionName: "paused" }),
  ]);

  if (paused) {
    return {
      submittable: false,
      code: "V14_PAUSED",
      reason: "the splitter is paused — every settlement reverts until it is unpaused",
    };
  }
  if (spent) {
    return {
      submittable: false,
      code: "V14_ALREADY_SETTLED",
      reason: `nonce ${q.nonce} has already been spent by ${q.payer} — this quote is settled, do not pay twice`,
    };
  }
  if (BigInt(expected) !== BigInt(q.nonce)) {
    return {
      submittable: false,
      code: "V14_STALE_NONCE",
      reason:
        `this quote was signed at nonce ${q.nonce} but the contract now expects ${expected} — ` +
        `another payment from this wallet settled first; request a fresh quote`,
    };
  }
  return { submittable: true };
}

const QUOTE_FIELDS = [
  { name: "payer", type: "address" },
  { name: "merchant", type: "address" },
  { name: "token", type: "address" },
  { name: "grossAmount", type: "uint256" },
  { name: "ipCreator", type: "address" },
  { name: "validUntil", type: "uint256" },
  { name: "orderIdHash", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "routeId", type: "bytes32" },
] as const;
const NATIVE_FUNCTION = "settleNative((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)";
const EXECUTION_ABI = parseAbi([
  "event Payment(bytes32 indexed paymentId,address indexed payer,address indexed merchant,address token,uint256 grossAmount,uint256 merchantAmount,uint256 treasuryAmount,uint256 ipCreatorAmount,uint256 validUntil,bytes32 routeId,bytes32 orderIdHash)",
  "function settleNative((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote,bytes signature) payable",
  "function profiles() view returns (address)",
  "function tokenList() view returns (address)",
  "function treasury() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
]);
const PROFILE_ABI = parseAbi([
  "function getProfile(bytes32) view returns ((uint16 treasuryBps,uint16 ipCreatorBps,bool enabled,uint64 configuredAt,address routeTreasury))",
]);

export interface V14ExecutionContext {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  orderId?: string;
  minSecondsRemaining?: number;
  /** Independently authorized purchase, not defaults copied from settlement_call. */
  expectedMerchant?: Address;
  expectedGrossAmount?: bigint;
  /** Maximum gas * maxFeePerGas, in native wei (in addition to purchase gross). */
  maxGasWei?: bigint;
  /** Persist before broadcast. A failed write prevents transmission. Never log the raw transaction. */
  onPrepared?: (tx: { hash: Hex; serializedTransaction: Hex }) => Promise<void>;
  /** @deprecated Preflight is mandatory; true is rejected. */
  skipPreflight?: boolean;
}

/**
 * Execute the existing v1.4 native ABI using independently pinned deployments.
 * Profiles/treasury remain administratively mutable by the accepted v1.4 trust
 * model; preflight checks their current values, not an immutable fee guarantee.
 * All legacy calls lacking explicit purchase authorization remain disabled.
 * Only local signing is supported so an exact transaction hash can be persisted
 * before transmission, including when the RPC loses the broadcast response.
 */
export async function executeV14Settlement(
  call: V14SettlementCall,
  ctx: V14ExecutionContext
): Promise<{ hash: Hex; route: string }> {
  const fail = (code: string, message: string): never => {
    throw new V14SettlementError(code, message);
  };
  if (
    !ctx.orderId ||
    !ctx.expectedMerchant ||
    typeof ctx.expectedGrossAmount !== "bigint" ||
    ctx.expectedGrossAmount <= 0n ||
    typeof ctx.maxGasWei !== "bigint" ||
    ctx.maxGasWei <= 0n ||
    typeof ctx.onPrepared !== "function" ||
    ctx.skipPreflight
  ) {
    fail(
      "V14_SETTLEMENT_DISABLED",
      "Native v1.4 execution requires an authorized order, merchant, exact gross, gas cap and durable prepared-transaction journal; preflight cannot be skipped."
    );
  }
  // Copy the untrusted call before awaiting: callers cannot change checked data
  // while RPC requests are in flight.
  call = structuredClone(call);
  const q = call?.args?.quote;
  if (!q) fail("V14_MALFORMED", "missing quote");
  for (const address of [call.contract, q.payer, q.merchant, q.token, q.ipCreator, ctx.account, ctx.expectedMerchant]) {
    if (!address || !isAddress(address, { strict: false })) fail("V14_MALFORMED", "invalid address");
  }
  for (const value of [q.grossAmount, q.validUntil, q.nonce, call.value_wei]) {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 2n ** 256n) {
      fail("V14_MALFORMED", "invalid uint256");
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(q.orderIdHash) || !/^0x[0-9a-fA-F]{64}$/.test(q.routeId)) {
    fail("V14_MALFORMED", "invalid bytes32");
  }
  if (
    ctx.minSecondsRemaining !== undefined &&
    (!Number.isFinite(ctx.minSecondsRemaining) || ctx.minSecondsRemaining < 30)
  ) {
    fail("V14_MALFORMED", "expiry headroom must be at least 30 seconds");
  }
  const validated = validateV14SettlementCall(call, {
    orderId: ctx.orderId,
    payer: ctx.account,
    minSecondsRemaining: ctx.minSecondsRemaining,
  });
  if (
    call.route !== validated.route ||
    call.arg_encoding !== "struct+signature" ||
    call.function !== NATIVE_FUNCTION ||
    JSON.stringify(call.field_order) !== JSON.stringify(QUOTE_FIELDS.map((f) => f.name))
  ) {
    fail("V14_CALL_MISMATCH", "route, method or quote field order disagrees with the supported ABI");
  }
  if (lc(q.token) !== ZERO || call.asset !== "POL" || lc(q.ipCreator) !== ZERO) {
    fail("V14_UNSUPPORTED_ASSET", "This executor supports native POL without creator payments only");
  }
  if (
    lc(q.merchant) === ZERO ||
    lc(q.merchant) !== lc(ctx.expectedMerchant!) ||
    BigInt(q.grossAmount) !== ctx.expectedGrossAmount
  ) {
    fail("V14_PURCHASE_MISMATCH", "signed merchant or gross does not match the authorized purchase");
  }
  if (call.nonce_at_signing !== undefined && call.nonce_at_signing !== q.nonce)
    fail("V14_MALFORMED", "nonce metadata disagrees with signed quote");
  const deployment = V14_DEPLOYMENTS[call.chain];
  if (
    !["polygon", "amoy"].includes(call.chain) ||
    !deployment ||
    deployment.status !== "enabled" ||
    !deployment.settlementEnabled ||
    lc(call.contract) !== lc(deployment.splitter.address)
  ) {
    fail("V14_UNTRUSTED_DEPLOYMENT", "settlement target is not an enabled pinned native deployment");
  }
  const { publicClient, walletClient } = ctx;
  const account = walletClient.account;
  if (!account || account.type !== "local" || lc(account.address) !== lc(ctx.account) || !account.signTransaction) {
    fail("V14_LOCAL_SIGNER_REQUIRED", "A matching local signer is required for recoverable broadcast");
  }
  const [rpcChain, walletChain, code] = await Promise.all([
    publicClient.getChainId(),
    walletClient.getChainId(),
    publicClient.getBytecode({ address: call.contract }),
  ]);
  if (
    rpcChain !== deployment.chainId ||
    walletChain !== deployment.chainId ||
    (walletClient.chain && walletClient.chain.id !== deployment.chainId)
  )
    fail("V14_CHAIN_MISMATCH", "wallet or RPC chain differs from pinned deployment");
  if (!code || code === "0x" || keccak256(code) !== deployment.runtimeCodeHash)
    fail("V14_RUNTIME_MISMATCH", "splitter bytecode does not match independently pinned runtime");
  const message = {
    ...q,
    grossAmount: BigInt(q.grossAmount),
    validUntil: BigInt(q.validUntil),
    nonce: BigInt(q.nonce),
  };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: {
        name: "B2BSplitterV14",
        version: "1",
        chainId: deployment.chainId,
        verifyingContract: deployment.splitter.address,
      },
      types: { Quote: QUOTE_FIELDS },
      primaryType: "Quote",
      message,
      signature: call.args.signature,
    });
  } catch {
    fail("V14_BAD_SIGNATURE", "quote signature cannot be recovered");
  }
  if (lc(signer!) !== lc(deployment.splitter.signer))
    fail("V14_UNTRUSTED_SIGNER", "quote signer does not match independent deployment pin");
  const [profiles, tokenList, treasury, signerHasRole, profile, preflight] = await Promise.all([
    publicClient.readContract({ address: call.contract, abi: EXECUTION_ABI, functionName: "profiles" }),
    publicClient.readContract({ address: call.contract, abi: EXECUTION_ABI, functionName: "tokenList" }),
    publicClient.readContract({ address: call.contract, abi: EXECUTION_ABI, functionName: "treasury" }),
    publicClient.readContract({
      address: call.contract,
      abi: EXECUTION_ABI,
      functionName: "hasRole",
      args: [keccak256(stringToHex("SIGN_OPERATOR_ROLE")), deployment.splitter.signer],
    }),
    publicClient.readContract({
      address: deployment.splitter.profiles,
      abi: PROFILE_ABI,
      functionName: "getProfile",
      args: [q.routeId],
    }),
    checkV14Submittable(publicClient, call),
  ]);
  if (
    lc(profiles) !== lc(deployment.splitter.profiles) ||
    lc(tokenList) !== lc(deployment.splitter.tokenList) ||
    lc(treasury) !== lc(deployment.splitter.treasury) ||
    !signerHasRole
  )
    fail("V14_DEPLOYMENT_STATE_MISMATCH", "satellite, treasury or signer role differs from deployment pin");
  const effectiveTreasury = lc(profile.routeTreasury) === ZERO ? treasury : profile.routeTreasury;
  if (
    !profile.enabled ||
    profile.treasuryBps !== (validated.route === "merchant-aifp1" ? 100 : 0) ||
    profile.ipCreatorBps !== 0 ||
    lc(effectiveTreasury) !== lc(deployment.splitter.treasury)
  ) {
    fail("V14_PROFILE_MISMATCH", "current profile differs from accepted route economics");
  }
  if (!preflight.submittable) fail(preflight.code, preflight.reason);
  const args = [message, call.args.signature] as const;
  await publicClient.simulateContract({
    address: call.contract,
    abi: EXECUTION_ABI,
    functionName: "settleNative",
    args,
    account: ctx.account,
    value: message.grossAmount,
  });
  const data = encodeFunctionData({ abi: EXECUTION_ABI, functionName: "settleNative", args });
  const [estimatedGas, fees, nonce, balance] = await Promise.all([
    publicClient.estimateGas({ account: ctx.account, to: call.contract, data, value: message.grossAmount }),
    publicClient.estimateFeesPerGas({ type: "eip1559", chain: publicClient.chain }),
    publicClient.getTransactionCount({ address: ctx.account, blockTag: "pending" }),
    publicClient.getBalance({ address: ctx.account, blockTag: "pending" }),
  ]);
  const gas = (estimatedGas * 120n + 99n) / 100n;
  if (
    gas <= 0n ||
    fees.maxFeePerGas <= 0n ||
    fees.maxPriorityFeePerGas < 0n ||
    fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
    gas * fees.maxFeePerGas > ctx.maxGasWei!
  ) {
    fail("V14_GAS_BUDGET_EXCEEDED", "estimated maximum transaction fee exceeds the operator gas budget");
  }
  if (balance < message.grossAmount + gas * fees.maxFeePerGas)
    fail("V14_INSUFFICIENT_BALANCE", "balance cannot cover authorized gross and maximum gas");
  // Check deadline again after slow RPCs, before signing or persisting anything.
  validateV14SettlementCall(call, {
    orderId: ctx.orderId,
    payer: ctx.account,
    minSecondsRemaining: ctx.minSecondsRemaining,
  });
  const serializedTransaction = await account!.signTransaction!({
    type: "eip1559",
    chainId: deployment.chainId,
    to: call.contract,
    value: message.grossAmount,
    data,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    nonce,
  });
  const hash = keccak256(serializedTransaction);
  await ctx.onPrepared!({ hash, serializedTransaction });
  // Once transmission is attempted every unknown result refers to this exact
  // signed transaction. A caller must recover it, never request a new quote.
  try {
    const returnedHash = await publicClient.sendRawTransaction({ serializedTransaction });
    if (lc(returnedHash) !== lc(hash)) throw new Error("RPC returned a different transaction hash");
  } catch {
    throw new SettlementConfirmationPendingError(hash, "settlement");
  }
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  } catch {
    throw new SettlementConfirmationPendingError(hash, "settlement");
  }
  if (lc(receipt.transactionHash) !== lc(hash)) throw new SettlementConfirmationPendingError(hash, "settlement");
  if (receipt.status !== "success" && receipt.status !== "reverted")
    throw new SettlementConfirmationPendingError(hash, "settlement");
  if (receipt.status === "reverted")
    fail("V14_TRANSACTION_REVERTED", `transaction ${hash} reverted; gas may have been charged`);
  const paymentId = keccak256(
    encodeAbiParameters(QUOTE_FIELDS, [
      q.payer,
      q.merchant,
      q.token,
      message.grossAmount,
      q.ipCreator,
      message.validUntil,
      q.orderIdHash,
      message.nonce,
      q.routeId,
    ])
  );
  const payment = receipt.logs
    .filter((log) => lc(log.address) === lc(call.contract))
    .flatMap((log) => {
      try {
        const event = decodeEventLog({ abi: EXECUTION_ABI, data: log.data, topics: log.topics });
        return event.eventName === "Payment" ? [event.args] : [];
      } catch {
        return [];
      }
    });
  if (
    payment.length !== 1 ||
    !payment.some(
      (p) =>
        lc(p.paymentId) === lc(paymentId) &&
        lc(p.payer) === lc(q.payer) &&
        lc(p.merchant) === lc(q.merchant) &&
        lc(p.token) === ZERO &&
        p.grossAmount === message.grossAmount &&
        p.validUntil === message.validUntil &&
        lc(p.routeId) === lc(q.routeId) &&
        lc(p.orderIdHash) === lc(q.orderIdHash) &&
        p.merchantAmount + p.treasuryAmount + p.ipCreatorAmount === message.grossAmount
    )
  ) {
    // Confirmation exists but payment evidence is inconclusive; retain the
    // prepared hash and prevent the purchase layer from starting another payment.
    throw new SettlementConfirmationPendingError(hash, "settlement");
  }
  return { hash, route: validated.route };
}
