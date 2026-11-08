/** Aptos and NEAR v1.4: native asset, owner-selected network, server call treated as untrusted. */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sha3_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { settlementHttp } from "./settlementHttp.js";
import type { SdkEnvironment } from "./deploymentResolver.js";
import {
  getAptosDeployment,
  getNearDeployment,
  resolveAptosDeployment,
  resolveNearDeployment,
} from "./accountDeploymentResolver.js";
import type { AptosV14Deployment } from "./generated/aptosV14Deployments.generated.js";
import type { NearV14Deployment } from "./generated/nearV14Deployments.generated.js";

export type AccountV14Family = "aptos" | "near";
export type AccountV14Network = "mainnet" | "testnet";

const APTOS_ROUTE = "0xb9dbf587b0df69870df1e60b22fba0317f53eb19d78a573abf94fc384a339a89";
const NEAR_ROUTE = "ROUTE_MERCHANT_AIFP1";
const APTOS_ZERO = `0x${"00".repeat(32)}`;
const NEAR_GAS = "300000000000000";
// Prepaid gas plus the conversion cost of the outer function call.
const NEAR_FEE_GAS = 305_000_000_000_000n;
const NEAR_STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;
const MAX_QUOTE_LIFETIME_S = 3600;
const APTOS_TX_LIFETIME_S = 60;
const APTOS_MAX_GAS = 2_000_000n;
const APTOS_MIN_GAS = 2_000n;
const PLAN_MAX_AGE_MS = 15_000;
const CONFIRM_POLL_MS = 1_000;
const NEAR_ACCOUNT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const APTOS_ACCOUNT = /^0x[0-9a-f]{64}$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface AptosV14Quote {
  payer: string;
  merchant: string;
  token: string;
  gross_amount: string;
  ip_creator: string;
  valid_until: string;
  order_id_hash: string;
  nonce: string;
  route_id: string;
}
export interface NearV14Quote {
  payer: string;
  merchant: string;
  token: "NEAR";
  gross_amount: string;
  ip_creator: null;
  valid_until_ms: number;
  order_id_hash: number[];
  nonce: number;
  route_id: string;
  payment_id: string;
}
interface AccountCallBase {
  network: AccountV14Network;
  network_mode: "live" | "test";
  contract: string;
  runtime_code_hash: string;
  splitter_version: "1.4";
  token_decimals: number;
  signer_public_key: string;
  treasury_owner: string;
  order_id: string;
  bound_to_payer: true;
}
export interface AptosV14SettlementCall extends AccountCallBase {
  chain: "aptos";
  chain_id: number;
  asset: "APT";
  args: { quote: AptosV14Quote; signature: string };
  function: "settle_native";
  payload: {
    type: "entry_function_payload";
    function: string;
    type_arguments: never[];
    arguments: string[];
  };
}
export interface NearV14SettlementCall extends AccountCallBase {
  chain: "near";
  chain_id: AccountV14Network;
  asset: "NEAR";
  args: { quote: NearV14Quote; signature: number[] };
  method_name: "pay";
  deposit: string;
  gas: string;
}
export type AccountV14SettlementCall = AptosV14SettlementCall | NearV14SettlementCall;

export interface AccountV14NativeSettlement {
  asset: "APT" | "NEAR";
  decimals: number;
  total_units: string;
  merchant_units: string;
  treasury_units: string;
  creator_units: string;
  settlement_semantics: "gross-inclusive";
  rate_usd: string;
  rate_fixed_at?: string;
}

/** The fields of a /v1/quote answer this module binds. */
export interface AccountV14QuoteFields {
  quote_id: string;
  payer?: string;
  amount: string;
  expires_at: string;
  network_mode?: string;
  accepted_chains: string[];
  accepted_assets: string[];
  pay_to: Record<string, string>;
  settlement_call?: unknown;
  native_settlement?: unknown;
  token_settlement?: unknown;
  payment_authorization?: {
    scheme: string;
    signature_encoding?: string;
    public_key_required?: boolean;
  };
}

export interface AccountV14Pin {
  family: AccountV14Family;
  network: AccountV14Network;
  networkMode: "live" | "test";
  contract: string;
  chainId: number | AccountV14Network;
  codeHash: string;
  asset: "APT" | "NEAR";
  decimals: 8 | 24;
  treasury?: string;
}

export interface AccountV14Signer {
  family: AccountV14Family;
  /** Canonical chain account, derived from publicKey unless the key was rotated. */
  address: string;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface AccountV14Prepared {
  family: AccountV14Family;
  network: AccountV14Network;
  contract: string;
  hash: string;
  signedTransactionBase64: string;
  /** Aptos 0x hex; NEAR ed25519:base58. */
  publicKey: string;
  maxFeeUnits: string;
}

export class AccountV14Error extends Error {
  constructor(
    public readonly code:
      "ACCOUNT_V14_INVALID" | "ACCOUNT_V14_UNAVAILABLE" | "ACCOUNT_V14_PENDING" | "ACCOUNT_V14_TRANSACTION_REVERTED",
    message: string,
    public readonly prepared?: AccountV14Prepared,
    public readonly actualFeeUnits?: bigint
  ) {
    super(message);
    this.name = "AccountV14Error";
  }
}

function fail(message: string): never {
  throw new AccountV14Error("ACCOUNT_V14_INVALID", message);
}
function need(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}
function unavailable(message: string): never {
  throw new AccountV14Error("ACCOUNT_V14_UNAVAILABLE", message);
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest();
}
function concat(...parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts);
}
function uintLe(value: bigint, width: number): Buffer {
  need(value >= 0n && value < 1n << BigInt(width * 8), "integer overflow");
  const out = Buffer.alloc(width);
  for (let i = 0; i < width; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return out;
}
function canonicalUint(value: unknown, width: number): bigint {
  need(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "amount must be a canonical integer string");
  const n = BigInt(value);
  need(n < 1n << BigInt(width * 8), "integer overflow");
  return n;
}
function hexBytes(value: unknown, length: number): Buffer {
  need(typeof value === "string" && new RegExp(`^0x[0-9a-f]{${length * 2}}$`).test(value), "invalid canonical bytes");
  return Buffer.from(value.slice(2), "hex");
}
function byteArray(value: unknown, length: number): Buffer {
  need(
    Array.isArray(value) && value.length === length && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
    "invalid byte array"
  );
  return Buffer.from(value as number[]);
}
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    sameJson(Object.keys(value).sort(), [...keys].sort())
  );
}

// Aptos BCS

function uleb128(value: number): Buffer {
  const out: number[] = [];
  let n = value;
  do {
    const byte = n & 0x7f;
    n >>>= 7;
    out.push(n ? byte | 0x80 : byte);
  } while (n);
  return Buffer.from(out);
}
function bcsBytes(bytes: Uint8Array): Buffer {
  return concat(uleb128(bytes.length), bytes);
}
function bcsString(value: string): Buffer {
  return bcsBytes(Buffer.from(value, "utf8"));
}

export interface AptosRawTransactionFields {
  sender: string;
  sequenceNumber: bigint;
  contract: string;
  quote: Pick<
    AptosV14Quote,
    "merchant" | "gross_amount" | "ip_creator" | "valid_until" | "order_id_hash" | "nonce" | "route_id"
  >;
  signature: string;
  maxGasAmount: bigint;
  gasUnitPrice: bigint;
  expirationTimestampSecs: bigint;
  chainId: number;
}

function aptosPayload(contract: string, q: AptosRawTransactionFields["quote"], signature: string): Buffer {
  const args = [
    hexBytes(q.merchant, 32),
    uintLe(BigInt(q.gross_amount), 8),
    hexBytes(q.ip_creator, 32),
    uintLe(BigInt(q.valid_until), 8),
    bcsBytes(hexBytes(q.order_id_hash, 32)),
    uintLe(BigInt(q.nonce), 8),
    bcsBytes(hexBytes(q.route_id, 32)),
    bcsBytes(hexBytes(signature, 65)),
  ];
  return concat(
    uleb128(2),
    hexBytes(contract, 32),
    bcsString("splitter"),
    bcsString("settle_native"),
    uleb128(0),
    uleb128(args.length),
    ...args.map(bcsBytes)
  );
}
export function encodeAptosRawTransaction(t: AptosRawTransactionFields): Buffer {
  need(Number.isInteger(t.chainId) && t.chainId > 0 && t.chainId < 256, "invalid Aptos chain id");
  return concat(
    hexBytes(t.sender, 32),
    uintLe(t.sequenceNumber, 8),
    aptosPayload(t.contract, t.quote, t.signature),
    uintLe(t.maxGasAmount, 8),
    uintLe(t.gasUnitPrice, 8),
    uintLe(t.expirationTimestampSecs, 8),
    Buffer.from([t.chainId])
  );
}
export function aptosSigningMessage(raw: Uint8Array): Buffer {
  return concat(sha3_256(Buffer.from("APTOS::RawTransaction")), raw);
}
export function encodeAptosSignedTransaction(raw: Uint8Array, publicKey: Uint8Array, signature: Uint8Array): Buffer {
  need(publicKey.length === 32 && signature.length === 64, "invalid Ed25519 authenticator");
  return concat(raw, uleb128(0), bcsBytes(publicKey), bcsBytes(signature));
}
export function aptosTransactionHash(signed: Uint8Array): string {
  const hash = sha3_256(concat(sha3_256(Buffer.from("APTOS::Transaction")), Buffer.from([0]), signed));
  return `0x${Buffer.from(hash).toString("hex")}`;
}
export function aptosAddressFromPublicKey(publicKey: Uint8Array): string {
  return `0x${Buffer.from(sha3_256(concat(publicKey, Buffer.from([0])))).toString("hex")}`;
}

// NEAR borsh

function borshBytes(bytes: Uint8Array): Buffer {
  return concat(uintLe(BigInt(bytes.length), 4), bytes);
}
function borshString(value: string): Buffer {
  return borshBytes(Buffer.from(value, "utf8"));
}

export interface NearTransactionFields {
  signerId: string;
  publicKey: Uint8Array;
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}
export function encodeNearTransaction(t: NearTransactionFields): Buffer {
  need(t.publicKey.length === 32 && t.blockHash.length === 32, "invalid NEAR key or block hash");
  return concat(
    borshString(t.signerId),
    Buffer.from([0]),
    t.publicKey,
    uintLe(t.nonce, 8),
    borshString(t.receiverId),
    t.blockHash,
    uintLe(1n, 4),
    Buffer.from([2]),
    borshString("pay"),
    borshBytes(t.args),
    uintLe(t.gas, 8),
    uintLe(t.deposit, 16)
  );
}
export function encodeNearSignedTransaction(transaction: Uint8Array, signature: Uint8Array): Buffer {
  need(signature.length === 64, "invalid NEAR signature");
  return concat(transaction, Buffer.from([0]), signature);
}
export function nearTransactionHash(transaction: Uint8Array): string {
  return bs58.encode(sha256(transaction));
}
export function nearPublicKeyString(publicKey: Uint8Array): string {
  return `ed25519:${bs58.encode(publicKey)}`;
}
function nearPayArgs(call: NearV14SettlementCall): Buffer {
  const q = call.args.quote;
  return Buffer.from(
    JSON.stringify({
      quote: {
        payer: q.payer,
        merchant: q.merchant,
        token: q.token,
        gross_amount: q.gross_amount,
        ip_creator: q.ip_creator,
        valid_until_ms: q.valid_until_ms,
        order_id_hash: q.order_id_hash,
        nonce: q.nonce,
        route_id: q.route_id,
        payment_id: q.payment_id,
      },
      signature: call.args.signature,
    }),
    "utf8"
  );
}

// Quote digests, as the contracts compute them

function encodeAptosQuoteBytes(q: AptosV14Quote): Buffer {
  return concat(
    hexBytes(q.payer, 32),
    hexBytes(q.merchant, 32),
    hexBytes(q.token, 32),
    uintLe(canonicalUint(q.gross_amount, 8), 8),
    hexBytes(q.ip_creator, 32),
    uintLe(canonicalUint(q.valid_until, 8), 8),
    hexBytes(q.order_id_hash, 32),
    uintLe(canonicalUint(q.nonce, 8), 8),
    hexBytes(q.route_id, 32)
  );
}
export function aptosV14Digest(contract: string, q: AptosV14Quote): Buffer {
  return sha256(Buffer.from("AiFinPay-Aptos-v1.4"), hexBytes(contract, 32), encodeAptosQuoteBytes(q));
}
export function nearV14Digest(contract: string, q: NearV14Quote): Buffer {
  need(q.ip_creator === null, "NEAR creator must be absent");
  return sha256(
    Buffer.from("AiFinPay-NEAR-v1.4"),
    Buffer.from(contract),
    borshString(q.payer),
    borshString(q.merchant),
    borshString(q.token),
    uintLe(canonicalUint(q.gross_amount, 16), 16),
    Buffer.from([0]),
    uintLe(BigInt(q.valid_until_ms), 8),
    byteArray(q.order_id_hash, 32),
    uintLe(BigInt(q.nonce), 8),
    borshString(q.route_id),
    borshString(q.payment_id)
  );
}
function recoverQuoteSigner(digest: Uint8Array, signature: Uint8Array): string {
  need(
    signature.length === 65 && (signature[64] === 27 || signature[64] === 28),
    "invalid quote signature recovery id"
  );
  const s = BigInt(`0x${Buffer.from(signature.subarray(32, 64)).toString("hex")}`);
  need(s <= SECP256K1_HALF_N, "non-canonical quote signature");
  const recovered = secp256k1.Signature.fromCompact(signature.subarray(0, 64))
    .addRecoveryBit(signature[64]! - 27)
    .recoverPublicKey(digest)
    .toRawBytes(false);
  return Buffer.from(recovered).toString("hex");
}

// Deployment selection

function pinOf(family: AccountV14Family, d: AptosV14Deployment | NearV14Deployment): AccountV14Pin {
  if (family === "aptos") {
    const a = d as AptosV14Deployment;
    const hash = a.modules.find((m) => m.name === "splitter")?.bytecodeHash;
    need(hash, "registry has no splitter module hash");
    return {
      family,
      network: a.network,
      networkMode: a.testnet ? "test" : "live",
      contract: a.packageAddress,
      chainId: a.chainId,
      codeHash: hash,
      asset: "APT",
      decimals: 8,
    };
  }
  const n = d as NearV14Deployment;
  return {
    family,
    network: n.network,
    networkMode: n.testnet ? "test" : "live",
    contract: n.contractAccountId,
    chainId: n.network,
    codeHash: n.wasmCodeHash,
    asset: "NEAR",
    decimals: 24,
    ...(n.treasuryAccountId ? { treasury: n.treasuryAccountId } : {}),
  };
}
export function accountV14Family(value: unknown): AccountV14Family | undefined {
  return value === "aptos" || value === "near" ? value : undefined;
}
/** Owner selection for a new payment; refuses a disabled registry record. */
export function authorizedAccountV14Pin(
  family: AccountV14Family,
  environment: SdkEnvironment,
  network: string
): AccountV14Pin {
  need(accountV14Family(family), "unknown account chain family");
  const options = { environment, network, version: "v1.4" as const };
  return pinOf(family, family === "aptos" ? resolveAptosDeployment(options) : resolveNearDeployment(options));
}
/** Registry identity for recovering an existing payment, even if later disabled. */
export function accountV14InventoryPin(
  family: AccountV14Family,
  environment: SdkEnvironment,
  network: string
): AccountV14Pin {
  need(accountV14Family(family), "unknown account chain family");
  const options = { environment, network, version: "v1.4" as const };
  return pinOf(family, family === "aptos" ? getAptosDeployment(options) : getNearDeployment(options));
}
export function validAccountV14Payer(family: AccountV14Family, payer: unknown): boolean {
  if (typeof payer !== "string") return false;
  if (family === "aptos") return APTOS_ACCOUNT.test(payer) && payer !== APTOS_ZERO;
  return payer.length >= 2 && payer.length <= 64 && NEAR_ACCOUNT.test(payer);
}

const CALL_KEYS = [
  "chain",
  "network",
  "network_mode",
  "contract",
  "chain_id",
  "runtime_code_hash",
  "splitter_version",
  "asset",
  "token_decimals",
  "args",
  "signer_public_key",
  "treasury_owner",
  "order_id",
  "bound_to_payer",
];
const APTOS_QUOTE_KEYS = [
  "payer",
  "merchant",
  "token",
  "gross_amount",
  "ip_creator",
  "valid_until",
  "order_id_hash",
  "nonce",
  "route_id",
];
const NEAR_QUOTE_KEYS = [
  "payer",
  "merchant",
  "token",
  "gross_amount",
  "ip_creator",
  "valid_until_ms",
  "order_id_hash",
  "nonce",
  "route_id",
  "payment_id",
];

function normalizedMerchant(family: AccountV14Family, value: unknown): string {
  need(typeof value === "string", "merchant has no payout destination on this chain");
  if (family === "near") return value;
  need(/^0x[0-9a-fA-F]{1,64}$/.test(value), "invalid Aptos merchant");
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

/**
 * Binds the server's call to the pinned deployment, the quote and the wallet.
 * Throws before anything is signed; `historical` skips only the clock.
 */
export function validateAccountV14Quote(
  quote: AccountV14QuoteFields,
  pin: AccountV14Pin,
  payer: string,
  historical = false
): AccountV14SettlementCall {
  const call = quote.settlement_call as AccountV14SettlementCall;
  need(call && typeof call === "object", "quote has no settlement call");
  need(validAccountV14Payer(pin.family, payer), "invalid payer account");
  need(call.chain === pin.family, "call chain mismatch");
  need(call.network === pin.network, "call network mismatch");
  need(call.network_mode === pin.networkMode, "call network mode mismatch");
  need(call.contract === pin.contract, "call contract is not the pinned deployment");
  need(call.chain_id === pin.chainId, "call chain id mismatch");
  need(call.runtime_code_hash === pin.codeHash, "call code hash is not the pinned deployment");
  need(call.splitter_version === "1.4", "call is not splitter v1.4");
  need(call.asset === pin.asset, "call asset mismatch");
  need(call.token_decimals === pin.decimals, "call decimals mismatch");
  need(call.bound_to_payer === true, "call is not bound to the payer");
  need(call.order_id === quote.quote_id, "call order id does not bind the quote id");
  need(typeof quote.quote_id === "string" && quote.quote_id.length > 0, "quote id missing");
  need(exactKeys(call.args, ["quote", "signature"]), "unexpected call arguments");

  need(quote.accepted_chains?.length === 1 && quote.accepted_chains[0] === pin.family, "quote chain mismatch");
  need(quote.accepted_assets?.length === 1 && quote.accepted_assets[0] === pin.asset, "quote asset mismatch");
  need((quote.network_mode ?? "live") === pin.networkMode, "quote network mode mismatch");
  need(quote.payer === payer, "quote names a different payer");
  need(quote.token_settlement === undefined, "account quotes settle in the native asset only");
  need(quote.payment_authorization?.scheme === "wallet-signature-v1", "unsupported receipt authorization");
  need(
    quote.payment_authorization?.signature_encoding === (pin.family === "aptos" ? "hex-ed25519" : "base58-ed25519"),
    "unexpected receipt signature encoding"
  );
  need(quote.payment_authorization?.public_key_required === true, "receipt authorization must bind the public key");

  const n = quote.native_settlement as AccountV14NativeSettlement | undefined;
  need(n && typeof n === "object", "quote has no native settlement");
  need(n.asset === pin.asset, "native settlement asset mismatch");
  need(n.decimals === pin.decimals, "native settlement decimals mismatch");
  need(n.settlement_semantics === "gross-inclusive", "native settlement is not gross-inclusive");

  const q = call.args.quote;
  need(q && typeof q === "object", "call has no quote");
  const gross = canonicalUint(q.gross_amount, pin.family === "aptos" ? 8 : 16);
  const treasury = gross / 100n;
  need(gross > 0n && treasury > 0n, "gross is too small for the protocol fee");
  need(q.gross_amount === n.total_units, "signed gross differs from the native total");
  need(n.merchant_units === (gross - treasury).toString(), "merchant leg is not 99%");
  need(n.treasury_units === treasury.toString(), "treasury leg is not 1%");
  need(n.creator_units === "0", "creator leg is not zero");

  need(q.payer === payer, "signed payer is not this wallet");
  const merchant = normalizedMerchant(pin.family, quote.pay_to?.[pin.family]);
  need(q.merchant === merchant, "signed merchant differs from the quoted payout destination");
  need(validAccountV14Payer(pin.family, q.merchant), "invalid signed merchant");
  need(q.merchant !== payer, "merchant equals payer");
  need(q.merchant !== pin.contract, "merchant equals the contract");
  need(call.treasury_owner !== payer, "treasury equals payer");
  need(call.treasury_owner !== q.merchant, "treasury equals merchant");
  need(call.treasury_owner !== pin.contract, "treasury equals the contract");

  const expiresAt = Math.floor(Date.parse(quote.expires_at) / 1000);
  need(Number.isSafeInteger(expiresAt), "invalid quote expiry");
  let validUntil: number;
  let digest: Buffer;
  let signature: Buffer;
  const orderHash = sha256(Buffer.from(quote.quote_id, "utf8"));

  if (call.chain === "aptos") {
    const a = q as AptosV14Quote;
    need(exactKeys(call, [...CALL_KEYS, "function", "payload"]), "unexpected Aptos call fields");
    need(exactKeys(a, APTOS_QUOTE_KEYS), "unexpected Aptos quote fields");
    need(a.token === APTOS_ZERO, "Aptos token is not the native marker");
    need(a.ip_creator === APTOS_ZERO, "Aptos creator is not zero");
    need(a.route_id === APTOS_ROUTE, "Aptos route is not merchant-aifp1");
    need(hexBytes(a.order_id_hash, 32).equals(orderHash), "Aptos order hash does not bind the quote id");
    canonicalUint(a.nonce, 8);
    validUntil = Number(canonicalUint(a.valid_until, 8));
    signature = hexBytes(call.args.signature, 65);
    need(call.function === "settle_native", "Aptos function mismatch");
    need(
      sameJson(call.payload, {
        type: "entry_function_payload",
        function: `${pin.contract}::splitter::settle_native`,
        type_arguments: [],
        arguments: [
          a.merchant,
          a.gross_amount,
          a.ip_creator,
          a.valid_until,
          a.order_id_hash,
          a.nonce,
          a.route_id,
          call.args.signature,
        ],
      }),
      "Aptos payload disagrees with the signed quote"
    );
    digest = aptosV14Digest(pin.contract, a);
  } else {
    const b = q as NearV14Quote;
    need(exactKeys(call, [...CALL_KEYS, "method_name", "deposit", "gas"]), "unexpected NEAR call fields");
    need(exactKeys(b, NEAR_QUOTE_KEYS), "unexpected NEAR quote fields");
    need(b.token === "NEAR", "NEAR token is not the native marker");
    need(b.ip_creator === null, "NEAR creator is not absent");
    need(b.route_id === NEAR_ROUTE, "NEAR route is not merchant-aifp1");
    need(b.payment_id === quote.quote_id, "NEAR payment id does not bind the quote id");
    need(/^[A-Za-z0-9_.:-]{1,128}$/.test(b.payment_id), "invalid NEAR payment id");
    need(byteArray(b.order_id_hash, 32).equals(orderHash), "NEAR order hash does not bind the quote id");
    need(Number.isSafeInteger(b.nonce) && b.nonce >= 0, "invalid NEAR nonce");
    need(Number.isSafeInteger(b.valid_until_ms) && b.valid_until_ms % 1000 === 0, "invalid NEAR expiry");
    validUntil = b.valid_until_ms / 1000;
    signature = byteArray(call.args.signature, 65);
    need(call.method_name === "pay", "NEAR method mismatch");
    need(call.deposit === b.gross_amount, "NEAR deposit differs from gross");
    need(call.gas === NEAR_GAS, "NEAR gas is not the reviewed amount");
    digest = nearV14Digest(pin.contract, b);
  }
  need(validUntil === expiresAt, "signed expiry differs from the quote expiry");
  const now = Math.floor(Date.now() / 1000);
  if (!historical) {
    need(validUntil > now, "quote expired");
    need(validUntil <= now + MAX_QUOTE_LIFETIME_S, "quote exceeds the maximum lifetime");
  }
  need(
    recoverQuoteSigner(digest, signature) === String(call.signer_public_key).replace(/^0x/, ""),
    "quote signature does not recover the stated signer"
  );
  return call;
}

// RPC

export interface AccountV14Rpc {
  get(path: string): Promise<unknown>;
  /** Aptos JSON or BCS POST under the node's /v1 base. */
  post(path: string, body: unknown, contentType?: string): Promise<unknown>;
  /** NEAR JSON-RPC. */
  call(method: string, params: unknown): Promise<unknown>;
}

export class AccountV14HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AccountV14HttpStatusError";
  }
}

export function accountV14Rpc(url: string, fetchImpl: typeof fetch = fetch): AccountV14Rpc {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail("invalid account chain RPC URL");
  }
  need(["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password, "invalid RPC URL");
  const base = url.replace(/\/+$/, "");
  let id = 0;
  const json = async (target: string, init: RequestInit): Promise<unknown> => {
    const { response, text } = await settlementHttp(fetchImpl, target, init);
    if (!response.ok)
      throw new AccountV14HttpStatusError(response.status, `account chain RPC answered ${response.status}`);
    return JSON.parse(text);
  };
  return {
    get: (path) => json(`${base}/${path.replace(/^\/+/, "")}`, { headers: { accept: "application/json" } }),
    post: (path, body, contentType = "application/json") =>
      json(`${base}/${path.replace(/^\/+/, "")}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": contentType },
        body: body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
      }),
    call: async (method, params) => {
      const data = (await json(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      })) as { error?: unknown; result?: { error?: unknown } };
      if (data.error || data.result?.error || !Object.hasOwn(data, "result"))
        unavailable(`NEAR RPC ${method} refused the request`);
      return data.result;
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aptosView(rpc: AccountV14Rpc, pin: AccountV14Pin, name: string, args: unknown[]): Promise<unknown[]> {
  const result = await rpc.post("view", {
    function: `${pin.contract}::splitter::${name}`,
    type_arguments: [],
    arguments: args,
  });
  need(Array.isArray(result), `Aptos view ${name} returned an unexpected shape`);
  return result;
}
async function nearView(rpc: AccountV14Rpc, pin: AccountV14Pin, name: string, args: unknown): Promise<unknown> {
  const result = (await rpc.call("query", {
    request_type: "call_function",
    finality: "final",
    account_id: pin.contract,
    method_name: name,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as { result?: unknown };
  need(Array.isArray(result?.result), `NEAR view ${name} returned an unexpected shape`);
  return JSON.parse(Buffer.from(result.result as number[]).toString("utf8"));
}
function liveUint(value: unknown, width = 8): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return canonicalUint(text, width);
}

export interface AptosV14Plan {
  family: "aptos";
  pin: AccountV14Pin;
  quoteId: string;
  payer: string;
  publicKey: Uint8Array;
  raw: Buffer;
  /** Consensus cap: max_gas_amount * gas_unit_price. */
  feeUnits: bigint;
  maxFeeUnits: bigint;
  createdAtMs: number;
}
export interface NearV14Plan {
  family: "near";
  pin: AccountV14Pin;
  quoteId: string;
  payer: string;
  publicKey: Uint8Array;
  transaction: Buffer;
  /** Pre-flight bound at the current gas price; unused gas is refunded. */
  feeUnits: bigint;
  maxFeeUnits: bigint;
  createdAtMs: number;
}
export type AccountV14Plan = AptosV14Plan | NearV14Plan;

export interface PrepareAccountV14Context {
  rpc: AccountV14Rpc;
  pin: AccountV14Pin;
  payer: string;
  publicKey: Uint8Array;
  maxFeeUnits: bigint;
}

function assertLiveQuoteSigner(liveSigner: Buffer, stated: string): void {
  need(liveSigner.length === 64, "live quote signer has an unexpected length");
  need(`04${liveSigner.toString("hex")}` === stated.replace(/^0x/, ""), "quote signer is not the contract's signer");
}

async function prepareAptos(
  quote: AccountV14QuoteFields,
  call: AptosV14SettlementCall,
  ctx: PrepareAccountV14Context
): Promise<AptosV14Plan> {
  const { rpc, pin, payer, maxFeeUnits, publicKey } = ctx;
  const q = call.args.quote;
  const ledger = (await rpc.get("")) as { chain_id?: unknown; ledger_timestamp?: unknown };
  need(ledger?.chain_id === pin.chainId, "RPC serves a different Aptos network");
  const module = (await rpc.get(`accounts/${pin.contract}/module/splitter`)) as { bytecode?: unknown };
  need(
    typeof module?.bytecode === "string" && /^0x(?:[0-9a-f]{2})+$/.test(module.bytecode),
    "live module has no bytecode"
  );
  need(
    `0x${sha256(Buffer.from(module.bytecode.slice(2), "hex")).toString("hex")}` === pin.codeHash,
    "live module differs from the pinned code hash"
  );
  const account = (await rpc.get(`accounts/${payer}`)) as {
    sequence_number?: unknown;
    authentication_key?: unknown;
  };
  need(account?.authentication_key === aptosAddressFromPublicKey(publicKey), "payer key is not the account's auth key");
  const sequenceNumber = liveUint(account.sequence_number);

  const [paused] = await aptosView(rpc, pin, "is_paused", []);
  need(paused === false, "contract is paused");
  const [liveSigner] = await aptosView(rpc, pin, "get_signer", []);
  assertLiveQuoteSigner(Buffer.from(String(liveSigner).replace(/^0x/, ""), "hex"), call.signer_public_key);
  const route = await aptosView(rpc, pin, "get_route_profile", [APTOS_ROUTE]);
  need(route.length === 5, "Aptos route profile has an unexpected shape");
  need(route[2] === true, "route is disabled");
  need(Number(route[0]) === 100, "live route treasury fee is not 100 bps");
  need(Number(route[1]) === 0, "live route creator fee is not zero");
  const [treasury] = await aptosView(rpc, pin, "get_treasury", []);
  const override = String(route[4]);
  const effective = /^0x0+$/.test(override) ? treasury : override;
  need(normalizedMerchant("aptos", effective) === call.treasury_owner, "call treasury differs from the live treasury");
  const [nonce] = await aptosView(rpc, pin, "get_payer_nonce", [payer]);
  need(String(nonce) === q.nonce, "signed nonce is not the live payer nonce");
  const [consumed] = await aptosView(rpc, pin, "is_consumed", [payer, q.nonce]);
  need(consumed === false, "signed nonce was already consumed");
  const [remoteDigest] = await aptosView(rpc, pin, "quote_digest", [
    q.payer,
    q.merchant,
    q.token,
    q.gross_amount,
    q.ip_creator,
    q.valid_until,
    q.order_id_hash,
    q.nonce,
    q.route_id,
  ]);
  need(
    hexBytes(remoteDigest, 32).equals(aptosV14Digest(pin.contract, q)),
    "local quote digest differs from the contract's"
  );

  const estimate = (await rpc.get("estimate_gas_price")) as { gas_estimate?: unknown };
  const gasUnitPrice = liveUint(estimate?.gas_estimate);
  need(gasUnitPrice > 0n, "invalid Aptos gas price");
  const budgetGas = maxFeeUnits / gasUnitPrice < APTOS_MAX_GAS ? maxFeeUnits / gasUnitPrice : APTOS_MAX_GAS;
  need(budgetGas >= APTOS_MIN_GAS, "Aptos fee budget cannot cover the minimum gas");
  const ledgerSeconds = liveUint(ledger.ledger_timestamp) / 1_000_000n;
  const validUntil = BigInt(q.valid_until);
  const candidate = ledgerSeconds + BigInt(APTOS_TX_LIFETIME_S);
  const fields: AptosRawTransactionFields = {
    sender: payer,
    sequenceNumber,
    contract: pin.contract,
    quote: q,
    signature: call.args.signature,
    maxGasAmount: budgetGas,
    gasUnitPrice,
    expirationTimestampSecs: candidate < validUntil ? candidate : validUntil,
    chainId: pin.chainId as number,
  };
  const simulate = async (raw: Buffer) => {
    const results = (await rpc.post(
      "transactions/simulate",
      encodeAptosSignedTransaction(raw, publicKey, Buffer.alloc(64)),
      "application/x.aptos.signed_transaction+bcs"
    )) as { success?: unknown; gas_used?: unknown; vm_status?: unknown }[];
    need(Array.isArray(results) && results.length === 1 && isObject(results[0]), "unexpected Aptos simulation shape");
    need(results[0]!.success === true, `Aptos simulation failed: ${String(results[0]!.vm_status).slice(0, 200)}`);
    return liveUint(results[0]!.gas_used);
  };
  const used = await simulate(encodeAptosRawTransaction(fields));
  need(used > 0n, "Aptos simulation reports no gas");
  const padded = (used * 3n) / 2n < APTOS_MIN_GAS ? APTOS_MIN_GAS : (used * 3n) / 2n;
  fields.maxGasAmount = padded < budgetGas ? padded : budgetGas;
  const raw = encodeAptosRawTransaction(fields);
  await simulate(raw);
  const feeUnits = fields.maxGasAmount * gasUnitPrice;
  need(feeUnits <= maxFeeUnits, "Aptos fee cap exceeded");
  return {
    family: "aptos",
    pin,
    quoteId: quote.quote_id,
    payer,
    publicKey,
    raw,
    feeUnits,
    maxFeeUnits,
    createdAtMs: Date.now(),
  };
}

async function prepareNear(
  quote: AccountV14QuoteFields,
  call: NearV14SettlementCall,
  ctx: PrepareAccountV14Context
): Promise<NearV14Plan> {
  const { rpc, pin, payer, maxFeeUnits, publicKey } = ctx;
  const q = call.args.quote;
  const status = (await rpc.call("status", [])) as { chain_id?: unknown };
  need(status?.chain_id === pin.network, "RPC serves a different NEAR network");
  const contract = (await rpc.call("query", {
    request_type: "view_account",
    finality: "final",
    account_id: pin.contract,
  })) as { code_hash?: unknown };
  need(typeof contract?.code_hash === "string", "live contract has no code hash");
  need(
    Buffer.from(bs58.decode(contract.code_hash)).toString("hex") === pin.codeHash,
    "live contract differs from the pinned code hash"
  );
  const paused = await nearView(rpc, pin, "is_paused", {});
  need(paused === false, "contract is paused");
  const liveSigner = byteArray(await nearView(rpc, pin, "get_signer", {}), 64);
  assertLiveQuoteSigner(liveSigner, call.signer_public_key);
  const route = (await nearView(rpc, pin, "get_route", { route_id: NEAR_ROUTE })) as {
    treasury_bps?: unknown;
    ip_creator_bps?: unknown;
    enabled?: unknown;
    route_treasury?: unknown;
  } | null;
  need(isObject(route), "route is unknown");
  need(route.enabled === true, "route is disabled");
  need(Number(route.treasury_bps) === 100, "live route treasury fee is not 100 bps");
  need(Number(route.ip_creator_bps) === 0, "live route creator fee is not zero");
  const treasury = route.route_treasury ?? (await nearView(rpc, pin, "get_treasury", {}));
  need(treasury === call.treasury_owner, "call treasury differs from the live treasury");
  if (pin.treasury) need(treasury === pin.treasury, "live treasury differs from the pinned treasury");
  const nonce = await nearView(rpc, pin, "get_payer_nonce", { payer });
  need(nonce === q.nonce, "signed nonce is not the live payer nonce");
  const paymentStatus = await nearView(rpc, pin, "get_payment_status", { payment_id: q.payment_id });
  need(paymentStatus === null, "payment id was already consumed");

  const publicKeyString = nearPublicKeyString(publicKey);
  const access = (await rpc.call("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: payer,
    public_key: publicKeyString,
  })) as { nonce?: unknown; permission?: unknown };
  need(access?.permission === "FullAccess", "payer key is not a full access key");
  const txNonce = liveUint(access.nonce) + 1n;

  const gas = (await rpc.call("gas_price", [null])) as { gas_price?: unknown };
  const gasPrice = liveUint(gas?.gas_price, 16);
  need(gasPrice > 0n, "invalid NEAR gas price");
  const feeUnits = NEAR_FEE_GAS * gasPrice;
  need(feeUnits <= maxFeeUnits, "NEAR fee cap exceeded");

  const payerAccount = (await rpc.call("query", {
    request_type: "view_account",
    finality: "final",
    account_id: payer,
  })) as { amount?: unknown; locked?: unknown; storage_usage?: unknown };
  const amount = liveUint(payerAccount?.amount, 16);
  const locked = liveUint(payerAccount?.locked, 16);
  const gross = BigInt(q.gross_amount);
  need(amount >= gross + feeUnits, "payer balance cannot cover the gross and the fee");
  need(
    amount + locked - gross - feeUnits >= liveUint(payerAccount?.storage_usage) * NEAR_STORAGE_PRICE_PER_BYTE,
    "payment would leave the payer below its storage reserve"
  );

  const block = (await rpc.call("block", { finality: "final" })) as { header?: { hash?: unknown } };
  need(typeof block?.header?.hash === "string", "NEAR block has no hash");
  const blockHash = bs58.decode(block.header.hash);
  need(blockHash.length === 32, "NEAR block hash has an unexpected length");

  return {
    family: "near",
    pin,
    quoteId: quote.quote_id,
    payer,
    publicKey,
    transaction: encodeNearTransaction({
      signerId: payer,
      publicKey,
      nonce: txNonce,
      receiverId: pin.contract,
      blockHash,
      args: nearPayArgs(call),
      gas: BigInt(call.gas),
      deposit: gross,
    }),
    feeUnits,
    maxFeeUnits,
    createdAtMs: Date.now(),
  };
}

/** Validates, reads live state and builds the exact unsigned transaction. Signs nothing. */
export async function prepareAccountV14Settlement(
  quote: AccountV14QuoteFields,
  ctx: PrepareAccountV14Context
): Promise<AccountV14Plan> {
  need(typeof ctx.maxFeeUnits === "bigint" && ctx.maxFeeUnits > 0n, "explicit fee budget required");
  need(ctx.publicKey?.length === 32, "invalid payer public key");
  if (ctx.pin.family === "near" && /^[0-9a-f]{64}$/.test(ctx.payer))
    need(Buffer.from(ctx.publicKey).toString("hex") === ctx.payer, "payer key is not this implicit account's key");
  const call = validateAccountV14Quote(quote, ctx.pin, ctx.payer);
  return call.chain === "aptos" ? prepareAptos(quote, call, ctx) : prepareNear(quote, call, ctx);
}

function feeFromAptos(tx: { gas_used?: unknown; gas_unit_price?: unknown }): bigint {
  return liveUint(tx.gas_used) * liveUint(tx.gas_unit_price);
}
function feeFromNear(result: {
  transaction_outcome?: { outcome?: { tokens_burnt?: unknown } };
  receipts_outcome?: { outcome?: { tokens_burnt?: unknown } }[];
}): bigint {
  let total = liveUint(result.transaction_outcome?.outcome?.tokens_burnt, 16);
  need(Array.isArray(result.receipts_outcome), "NEAR outcome has no receipts");
  for (const r of result.receipts_outcome) total += liveUint(r?.outcome?.tokens_burnt, 16);
  return total;
}

async function readAptosOutcome(
  rpc: AccountV14Rpc,
  p: AccountV14Prepared,
  payer: string
): Promise<{ state: "pending" } | { state: "success" } | { state: "reverted"; fee: bigint }> {
  let tx: {
    type?: unknown;
    hash?: unknown;
    success?: unknown;
    sender?: unknown;
    gas_used?: unknown;
    gas_unit_price?: unknown;
  };
  try {
    tx = (await rpc.get(`transactions/by_hash/${p.hash}`)) as typeof tx;
  } catch (error) {
    if (error instanceof AccountV14HttpStatusError && error.status === 404) return { state: "pending" };
    throw error;
  }
  if (tx?.type === "pending_transaction") return { state: "pending" };
  need(tx?.type === "user_transaction", "Aptos hash resolves to an unexpected transaction type");
  need(tx.hash === p.hash, "Aptos RPC returned a different transaction");
  need(tx.sender === payer, "Aptos transaction has a different sender");
  if (tx.success === true) return { state: "success" };
  need(tx.success === false, "Aptos transaction has no outcome");
  return { state: "reverted", fee: feeFromAptos(tx) };
}

async function readNearOutcome(
  rpc: AccountV14Rpc,
  p: AccountV14Prepared,
  payer: string
): Promise<{ state: "pending" } | { state: "success" } | { state: "reverted"; fee: bigint }> {
  let result: {
    final_execution_status?: unknown;
    status?: { Failure?: unknown };
    transaction?: { hash?: unknown; signer_id?: unknown; receiver_id?: unknown };
    transaction_outcome?: { outcome?: { tokens_burnt?: unknown } };
    receipts_outcome?: { outcome?: { tokens_burnt?: unknown } }[];
  };
  try {
    result = (await rpc.call("EXPERIMENTAL_tx_status", {
      tx_hash: p.hash,
      sender_account_id: payer,
      // Waiting for FINAL on a transaction the node has not seen blocks until the HTTP timeout.
      wait_until: "NONE",
    })) as typeof result;
  } catch (error) {
    if (error instanceof AccountV14Error && error.code === "ACCOUNT_V14_UNAVAILABLE") return { state: "pending" };
    throw error;
  }
  if (result?.final_execution_status !== "FINAL") return { state: "pending" };
  need(result.transaction?.hash === p.hash, "NEAR RPC returned a different transaction");
  need(result.transaction?.signer_id === payer, "NEAR transaction has a different signer");
  need(result.transaction?.receiver_id === p.contract, "NEAR transaction has a different receiver");
  if (result.status?.Failure !== undefined) return { state: "reverted", fee: feeFromNear(result) };
  return { state: "success" };
}

function readOutcome(rpc: AccountV14Rpc, p: AccountV14Prepared, payer: string) {
  return p.family === "aptos" ? readAptosOutcome(rpc, p, payer) : readNearOutcome(rpc, p, payer);
}

/** Signed bytes and the hash reach onPrepared before the single broadcast. */
export async function executeAccountV14Settlement(
  plan: AccountV14Plan,
  ctx: {
    rpc: AccountV14Rpc;
    signer: AccountV14Signer;
    onPrepared: (p: AccountV14Prepared) => Promise<void>;
    confirmMs?: number;
  }
): Promise<AccountV14Prepared> {
  need(ctx.signer.family === plan.family, "signer family mismatch");
  need(ctx.signer.address === plan.payer, "signer is not the planned payer");
  need(Buffer.from(ctx.signer.publicKey).equals(Buffer.from(plan.publicKey)), "signer key is not the planned key");
  need(Date.now() - plan.createdAtMs <= PLAN_MAX_AGE_MS, "stale preparation");
  need(plan.feeUnits <= plan.maxFeeUnits, "fee cap exceeded");
  const message = plan.family === "aptos" ? aptosSigningMessage(plan.raw) : sha256(plan.transaction);
  const signature = await ctx.signer.sign(message);
  need(signature?.length === 64, "wallet returned an invalid signature");
  need(nacl.sign.detached.verify(message, signature, plan.publicKey), "wallet signature does not verify");
  const signed =
    plan.family === "aptos"
      ? encodeAptosSignedTransaction(plan.raw, plan.publicKey, signature)
      : encodeNearSignedTransaction(plan.transaction, signature);
  const prepared: AccountV14Prepared = {
    family: plan.family,
    network: plan.pin.network,
    contract: plan.pin.contract,
    hash: plan.family === "aptos" ? aptosTransactionHash(signed) : nearTransactionHash(plan.transaction),
    signedTransactionBase64: signed.toString("base64"),
    publicKey:
      plan.family === "aptos"
        ? `0x${Buffer.from(plan.publicKey).toString("hex")}`
        : nearPublicKeyString(plan.publicKey),
    maxFeeUnits: plan.maxFeeUnits.toString(),
  };
  await ctx.onPrepared(prepared);
  const pending = () =>
    new AccountV14Error("ACCOUNT_V14_PENDING", "Unknown outcome; recover this transaction without resending", prepared);
  try {
    if (plan.family === "aptos") {
      const sent = (await ctx.rpc.post("transactions", signed, "application/x.aptos.signed_transaction+bcs")) as {
        hash?: unknown;
      };
      need(sent?.hash === prepared.hash, "Aptos RPC returned a different hash");
    } else {
      await ctx.rpc.call("send_tx", { signed_tx_base64: prepared.signedTransactionBase64, wait_until: "NONE" });
    }
    const deadline = Date.now() + (ctx.confirmMs ?? 60_000);
    for (;;) {
      let outcome: Awaited<ReturnType<typeof readOutcome>> = { state: "pending" };
      try {
        outcome = await readOutcome(ctx.rpc, prepared, plan.payer);
      } catch (error) {
        if (error instanceof AccountV14Error) throw error;
      }
      if (outcome.state === "success") return prepared;
      if (outcome.state === "reverted") {
        need(outcome.fee <= plan.maxFeeUnits, "reverted transaction burned more than the fee cap");
        throw new AccountV14Error(
          "ACCOUNT_V14_TRANSACTION_REVERTED",
          "Original transaction reverted; fee retained, do not pay again with this quote",
          prepared,
          outcome.fee
        );
      }
      if (Date.now() >= deadline) throw pending();
      await sleep(CONFIRM_POLL_MS);
    }
  } catch (error) {
    if (error instanceof AccountV14Error && error.code === "ACCOUNT_V14_TRANSACTION_REVERTED") throw error;
    throw pending();
  }
}

/** Read-only reconciliation of the saved transaction; null means no proven revert. */
export async function readAccountV14Revert(
  rpc: AccountV14Rpc,
  p: AccountV14Prepared,
  payer: string,
  maxFeeUnits: bigint
): Promise<bigint | null> {
  const outcome = await readOutcome(rpc, p, payer);
  if (outcome.state !== "reverted") return null;
  need(outcome.fee <= maxFeeUnits, "reverted transaction burned more than the fee cap");
  return outcome.fee;
}

class Cursor {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}
  take(length: number): Buffer {
    need(length >= 0 && this.offset + length <= this.bytes.length, "truncated signed transaction");
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE();
  }
  done(): boolean {
    return this.offset === this.bytes.length;
  }
  get position(): number {
    return this.offset;
  }
}

/** Offline proof that saved bytes are exactly this quote's payment by this wallet. */
export function assertPreparedAccountV14Recovery(
  quote: AccountV14QuoteFields,
  p: AccountV14Prepared,
  pin: AccountV14Pin,
  payer: string
): void {
  const call = validateAccountV14Quote(quote, pin, payer, true);
  need(p?.family === pin.family, "recovery family mismatch");
  need(p.network === pin.network, "recovery network mismatch");
  need(p.contract === pin.contract, "recovery contract mismatch");
  need(/^[1-9][0-9]*$/.test(p.maxFeeUnits), "recovery has no fee cap");
  need(typeof p.signedTransactionBase64 === "string", "recovery has no signed bytes");
  const bytes = Buffer.from(p.signedTransactionBase64, "base64");
  need(bytes.length > 0 && bytes.toString("base64") === p.signedTransactionBase64, "invalid signed bytes");

  if (call.chain === "aptos") {
    const key = hexBytes(p.publicKey, 32);
    need(aptosAddressFromPublicKey(key) === payer, "recovery key is not this payer's");
    const cursor = new Cursor(bytes);
    cursor.take(32);
    const sequenceNumber = cursor.u64();
    const payload = aptosPayload(pin.contract, call.args.quote, call.args.signature);
    need(cursor.take(payload.length).equals(payload), "signed payload differs from the quote");
    const maxGasAmount = cursor.u64();
    const gasUnitPrice = cursor.u64();
    const expirationTimestampSecs = cursor.u64();
    cursor.take(1);
    const rawLength = cursor.position;
    const raw = encodeAptosRawTransaction({
      sender: payer,
      sequenceNumber,
      contract: pin.contract,
      quote: call.args.quote,
      signature: call.args.signature,
      maxGasAmount,
      gasUnitPrice,
      expirationTimestampSecs,
      chainId: pin.chainId as number,
    });
    need(raw.equals(bytes.subarray(0, rawLength)), "signed transaction differs from this payment");
    need(maxGasAmount * gasUnitPrice <= BigInt(p.maxFeeUnits), "signed fee exceeds the saved cap");
    cursor.take(1);
    cursor.take(1);
    cursor.take(32);
    cursor.take(1);
    const signature = cursor.take(64);
    need(cursor.done(), "trailing bytes in signed transaction");
    need(
      encodeAptosSignedTransaction(raw, key, signature).equals(bytes),
      "signed authenticator differs from this payment"
    );
    need(nacl.sign.detached.verify(aptosSigningMessage(raw), signature, key), "signature does not verify");
    need(aptosTransactionHash(bytes) === p.hash, "saved hash differs from the signed bytes");
    return;
  }

  need(typeof p.publicKey === "string" && p.publicKey.startsWith("ed25519:"), "invalid NEAR recovery key");
  const key = bs58.decode(p.publicKey.slice(8));
  need(key.length === 32, "invalid NEAR recovery key");
  const signerLength = bytes.readUInt32LE(0);
  const receiverOffset = 4 + signerLength + 33 + 8;
  need(bytes.length > receiverOffset + 4, "truncated signed transaction");
  const nonce = bytes.readBigUInt64LE(4 + signerLength + 33);
  const receiverLength = bytes.readUInt32LE(receiverOffset);
  const blockOffset = receiverOffset + 4 + receiverLength;
  need(bytes.length >= blockOffset + 32, "truncated signed transaction");
  const transaction = encodeNearTransaction({
    signerId: payer,
    publicKey: key,
    nonce,
    receiverId: pin.contract,
    blockHash: bytes.subarray(blockOffset, blockOffset + 32),
    args: nearPayArgs(call),
    gas: BigInt(call.gas),
    deposit: BigInt(call.args.quote.gross_amount),
  });
  need(bytes.length === transaction.length + 65, "signed transaction has an unexpected length");
  need(bytes.subarray(0, transaction.length).equals(transaction), "signed transaction differs from this payment");
  need(bytes[transaction.length] === 0, "unexpected signature type");
  const signature = bytes.subarray(transaction.length + 1);
  need(nacl.sign.detached.verify(sha256(transaction), signature, key), "signature does not verify");
  need(nearTransactionHash(transaction) === p.hash, "saved hash differs from the signed bytes");
}

/** Whole USD micros of a native amount, rounded up. */
export function accountV14CostUsd(units: bigint, decimals: number, rate: string): number {
  need(
    typeof rate === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(rate) && units >= 0n,
    "invalid exact USD rate"
  );
  need(Number(rate) > 0 && Number(rate) < 100_000, "invalid USD rate");
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(whole! + fraction);
  const denominator = 10n ** BigInt(fraction.length + decimals);
  const micros = (units * numerator * 1_000_000n + denominator - 1n) / denominator;
  need(micros <= BigInt(Number.MAX_SAFE_INTEGER), "unsafe USD accounting");
  return Number(micros) / 1e6;
}

/** Local Ed25519 signer from a domain-separated seed. */
export function accountV14SignerFromSeed(family: AccountV14Family, seed: Uint8Array): AccountV14Signer {
  need(accountV14Family(family) && seed?.length === 32, "invalid account signer seed");
  const pair = nacl.sign.keyPair.fromSeed(seed);
  return {
    family,
    address:
      family === "aptos" ? aptosAddressFromPublicKey(pair.publicKey) : Buffer.from(pair.publicKey).toString("hex"),
    publicKey: pair.publicKey,
    sign: async (message) => nacl.sign.detached(message, pair.secretKey),
  };
}
/** /v1/pay encoding of an Ed25519 signature over the receipt statement. */
export function encodeAccountV14AuthSignature(family: AccountV14Family, signature: Uint8Array): string {
  return family === "aptos" ? `0x${Buffer.from(signature).toString("hex")}` : bs58.encode(signature);
}
export function accountV14PublicKeyString(family: AccountV14Family, publicKey: Uint8Array): string {
  return family === "aptos" ? `0x${Buffer.from(publicKey).toString("hex")}` : nearPublicKeyString(publicKey);
}
