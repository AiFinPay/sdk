import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { UntrustedPaymentTargetError } from "./errors.js";

export const SOLANA_PROGRAM_ID = "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const VALID_FROM = Date.parse("2026-08-04T00:00:00.000Z");
const VALID_UNTIL = Date.parse("2026-09-03T00:00:00.000Z");
export const SOLANA_ROUTE_ENABLED = false;

export interface SolanaPaymentQuote {
  chain?: string;
  program_id?: string;
  instruction?: string;
  agent_pubkey?: string;
  merchant_wallet?: string;
  treasury?: string;
  ip_creator?: string;
  merchant_amount_lamports?: string;
  treasury_fee_lamports?: string;
  ip_creator_fee_lamports?: string;
  total_lamports?: string;
  payment_id?: string;
  payment_receipt?: string;
  creator_fee_enabled?: boolean;
  order_id?: string;
}

export interface ValidatedSolanaPayment {
  program_id: string;
  agent_pubkey: string;
  merchant_wallet: string;
  treasury: string;
  ip_creator: string;
  payment_receipt: string;
  paymentId: Buffer;
  merchantAmountLamports: bigint;
  totalLamports: bigint;
  creatorFeeEnabled: boolean;
  order_id: string;
}

function reject(reason: string): never {
  throw new UntrustedPaymentTargetError(`[PAY_TARGET_UNTRUSTED] solana_${reason}`);
}

function pubkey(value: unknown, label: string): string {
  if (typeof value !== "string") reject(`${label}_invalid`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    reject(`${label}_invalid`);
  }
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) reject(`${label}_invalid`);
  const result = BigInt(value);
  if (result > 0xffffffffffffffffn) reject(`${label}_overflow`);
  return result;
}

function derivePaymentId(
  payer: PublicKey,
  merchant: PublicKey,
  merchantAmount: bigint,
  creator: PublicKey,
  creatorEnabled: boolean,
  orderId: string,
): Buffer {
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(merchantAmount);
  return createHash("sha256")
    .update(Buffer.from("AiFinPay-solana-payment-v1"))
    .update(payer.toBuffer())
    .update(merchant.toBuffer())
    .update(amount)
    .update(creator.toBuffer())
    .update(Buffer.from([creatorEnabled ? 1 : 0]))
    .update(Buffer.from(orderId, "utf8"))
    .digest();
}

function hex32(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) reject(`${label}_invalid`);
  return Buffer.from(value.slice(2), "hex");
}

export function validateSolanaPaymentQuote(
  quote: SolanaPaymentQuote,
  registeredMerchant: string,
  expectedAgent: string,
  nowMs = Date.now(),
): ValidatedSolanaPayment {
  if (!SOLANA_ROUTE_ENABLED) reject("route_disabled_pending_v0_6_upgrade");
  return validateSolanaPaymentQuoteTerms(quote, registeredMerchant, expectedAgent, nowMs);
}

/** Pure candidate validation for tests and upgrade tooling. It never authorizes
 * signing; callers must use validateSolanaPaymentQuote(). */
export function validateSolanaPaymentQuoteTerms(
  quote: SolanaPaymentQuote,
  registeredMerchant: string,
  expectedAgent: string,
  nowMs = Date.now(),
): ValidatedSolanaPayment {
  if (nowMs < VALID_FROM || nowMs >= VALID_UNTIL) reject("registry_entry_expired");
  if (quote.chain !== "solana") reject("chain_mismatch");
  if (pubkey(quote.program_id, "program_id") !== SOLANA_PROGRAM_ID) reject("program_not_registered");
  if (quote.instruction !== "b2b_pay_with_split") reject("instruction_mismatch");

  const payer = new PublicKey(pubkey(quote.agent_pubkey, "agent"));
  if (!payer.equals(new PublicKey(pubkey(expectedAgent, "expected_agent")))) reject("agent_mismatch");
  const merchant = new PublicKey(pubkey(quote.merchant_wallet, "merchant"));
  if (!merchant.equals(new PublicKey(pubkey(registeredMerchant, "registered_merchant")))) reject("merchant_mismatch");
  const treasury = new PublicKey(pubkey(quote.treasury, "treasury"));
  const creator = new PublicKey(pubkey(quote.ip_creator, "ip_creator"));
  const creatorEnabled = quote.creator_fee_enabled === true;
  if (merchant.equals(payer) || merchant.equals(treasury)) reject("invalid_merchant");
  if (creatorEnabled) {
    if (creator.equals(payer) || creator.equals(merchant) || creator.equals(treasury)) reject("invalid_creator");
  } else if (!creator.equals(treasury)) {
    reject("invalid_creator");
  }

  if (!quote.order_id || typeof quote.order_id !== "string" || Buffer.byteLength(quote.order_id) > 64) {
    reject("order_id_invalid");
  }
  const merchantAmount = uint(quote.merchant_amount_lamports, "merchant_amount_lamports");
  if (merchantAmount === 0n) reject("merchant_amount_lamports_zero");
  const treasuryFee = merchantAmount * 100n / 10_000n;
  const creatorFee = creatorEnabled ? merchantAmount * 1n / 10_000n : 0n;
  if (treasuryFee === 0n || (creatorEnabled && creatorFee === 0n)) reject("amount_below_fee_floor");
  const total = merchantAmount + treasuryFee + creatorFee;
  for (const [value, expected, label] of [
    [quote.treasury_fee_lamports, treasuryFee, "treasury_fee_lamports"],
    [quote.ip_creator_fee_lamports, creatorFee, "ip_creator_fee_lamports"],
    [quote.total_lamports, total, "total_lamports"],
  ] as const) {
    if (uint(value, label) !== expected) reject(`${label}_mismatch`);
  }

  const expectedPaymentId = derivePaymentId(
    payer, merchant, merchantAmount, creator, creatorEnabled, quote.order_id,
  );
  if (!hex32(quote.payment_id, "payment_id").equals(expectedPaymentId)) reject("payment_id_mismatch");
  const [expectedReceipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("b2b-payment"), payer.toBuffer(), expectedPaymentId],
    new PublicKey(SOLANA_PROGRAM_ID),
  );
  const receipt = pubkey(quote.payment_receipt, "payment_receipt");
  if (receipt !== expectedReceipt.toBase58()) reject("payment_receipt_mismatch");

  return {
    program_id: SOLANA_PROGRAM_ID,
    agent_pubkey: payer.toBase58(),
    merchant_wallet: merchant.toBase58(),
    treasury: treasury.toBase58(),
    ip_creator: creator.toBase58(),
    payment_receipt: receipt,
    paymentId: expectedPaymentId,
    merchantAmountLamports: merchantAmount,
    totalLamports: total,
    creatorFeeEnabled: creatorEnabled,
    order_id: quote.order_id,
  };
}
