import { getAddress, isAddress, keccak256 } from "viem";
import { UntrustedPaymentTargetError } from "./errors.js";

export interface TrustedPaymentTarget {
  chainId: number;
  version: "1.1" | "1.2";
  splitter: `0x${string}`;
  runtimeCodeHash: `0x${string}`;
  treasury: `0x${string}`;
  treasuryBps: number;
  ipCreatorBps: number;
  enabled: boolean;
  validFrom: string;
  validUntil: string;
}

export interface QuotedNativePayment {
  chain?: string;
  splitter?: string;
  splitter_version?: string;
  merchant_wallet?: string;
  total_wei?: string;
  merchant_amount_wei?: string;
  treasury_amount_wei?: string;
  ip_creator_amount_wei?: string;
  ip_creator?: string;
  order_id?: string;
  function_signature?: string;
}

export interface ValidatedNativePayment {
  splitter: `0x${string}`;
  merchant: `0x${string}`;
  ipCreator: `0x${string}`;
  totalWei: bigint;
  orderId: string;
  version: "1.2";
}

function reject(reason: string): never {
  throw new UntrustedPaymentTargetError(`[PAY_TARGET_UNTRUSTED] ${reason}`);
}

function sameAddress(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && isAddress(actual) && getAddress(actual) === getAddress(expected);
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    reject(`${label}_invalid`);
  }
  return BigInt(value);
}

export function validateQuotedNativePayment(
  chain: string,
  quote: QuotedNativePayment,
  target: TrustedPaymentTarget,
  registeredMerchant: string,
  nowMs = Date.now(),
): ValidatedNativePayment {
  if (!target.enabled) reject("route_disabled");
  if (target.version !== "1.2") reject("legacy_v1_1_disabled");
  const validFrom = Date.parse(target.validFrom);
  const validUntil = Date.parse(target.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil) {
    reject("registry_window_invalid");
  }
  if (nowMs < validFrom || nowMs >= validUntil) reject("registry_entry_expired");
  if (quote.chain !== chain) reject("chain_mismatch");
  if (!sameAddress(quote.splitter, target.splitter)) reject("splitter_not_registered");
  if (quote.splitter_version !== target.version) reject("version_mismatch");
  if (!sameAddress(quote.merchant_wallet, registeredMerchant)) reject("merchant_mismatch");
  if (!quote.order_id || typeof quote.order_id !== "string" || quote.order_id.length > 256) {
    reject("order_id_invalid");
  }
  if (
    quote.function_signature !== undefined &&
    quote.function_signature !== "payNative(bytes32,address,address,string)"
  ) {
    reject("function_signature_mismatch");
  }
  if (quote.ip_creator !== undefined && !sameAddress(quote.ip_creator, target.treasury)) {
    reject("ip_creator_not_registered");
  }

  const totalWei = uint(quote.total_wei, "total_wei");
  if (totalWei === 0n) reject("total_wei_zero");
  const treasuryAmount = (totalWei * BigInt(target.treasuryBps)) / 10_000n;
  const ipCreatorAmount = (totalWei * BigInt(target.ipCreatorBps)) / 10_000n;
  const merchantAmount = totalWei - treasuryAmount - ipCreatorAmount;
  const components: Array<[unknown, bigint, string]> = [
    [quote.treasury_amount_wei, treasuryAmount, "treasury_amount_wei"],
    [quote.ip_creator_amount_wei, ipCreatorAmount, "ip_creator_amount_wei"],
    [quote.merchant_amount_wei, merchantAmount, "merchant_amount_wei"],
  ];
  for (const [supplied, expected, label] of components) {
    if (supplied !== undefined && uint(supplied, label) !== expected) reject(`${label}_mismatch`);
  }

  return {
    splitter: target.splitter,
    merchant: getAddress(registeredMerchant) as `0x${string}`,
    ipCreator: target.treasury,
    totalWei,
    orderId: quote.order_id,
    version: "1.2",
  };
}

export interface TargetReader {
  getChainId(): Promise<number>;
  getBytecode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

const TARGET_ABI = [
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ipCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export async function validateRuntimePaymentTarget(
  reader: TargetReader,
  target: TrustedPaymentTarget,
): Promise<void> {
  let chainId: number;
  let code: `0x${string}` | undefined;
  try {
    chainId = await reader.getChainId();
    code = await reader.getBytecode({ address: target.splitter });
  } catch {
    reject("rpc_unavailable");
  }
  if (chainId !== target.chainId) reject("rpc_chain_mismatch");
  if (!code || code === "0x") reject("splitter_has_no_code");
  if (keccak256(code) !== target.runtimeCodeHash) reject("runtime_codehash_mismatch");

  let treasury: unknown;
  let owner: unknown;
  let treasuryBps: unknown;
  let ipCreatorBps: unknown;
  try {
    [treasury, owner, treasuryBps, ipCreatorBps] = await Promise.all(
      ["treasury", "owner", "treasuryBps", "ipCreatorBps"].map((functionName) =>
        reader.readContract({ address: target.splitter, abi: TARGET_ABI, functionName }),
      ),
    );
  } catch {
    reject("contract_introspection_failed");
  }
  if (!sameAddress(treasury, target.treasury)) reject("treasury_mismatch");
  if (!sameAddress(owner, target.treasury)) reject("governance_not_approved");
  if (Number(treasuryBps) !== target.treasuryBps) reject("treasury_fee_mismatch");
  if (Number(ipCreatorBps) !== target.ipCreatorBps) reject("royalty_fee_mismatch");
}
