import { PublicKey } from "@solana/web3.js";
import { UntrustedPaymentTargetError } from "./errors.js";

export const SOLANA_PROGRAM_ID = "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2";
const VALID_FROM = Date.parse("2026-08-04T00:00:00.000Z");
const VALID_UNTIL = Date.parse("2026-09-03T00:00:00.000Z");

export interface SolanaPaymentQuote {
  chain?: string;
  program_id?: string;
  instruction?: string;
  merchant_wallet?: string;
  treasury?: string;
  merchant_amount_lamports?: string;
  treasury_amount_lamports?: string;
  ip_creator_amount_lamports?: string;
  total_lamports?: string;
  order_id?: string;
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
  return BigInt(value);
}

export function validateSolanaPaymentQuote(
  quote: SolanaPaymentQuote,
  registeredMerchant: string,
  nowMs = Date.now(),
): Required<Pick<SolanaPaymentQuote, "program_id" | "merchant_wallet" | "treasury" | "order_id">> & { totalLamports: bigint } {
  if (nowMs < VALID_FROM || nowMs >= VALID_UNTIL) reject("registry_entry_expired");
  if (quote.chain !== "solana") reject("chain_mismatch");
  if (pubkey(quote.program_id, "program_id") !== SOLANA_PROGRAM_ID) reject("program_not_registered");
  if (quote.instruction !== "b2b_pay") reject("instruction_mismatch");
  const merchant = pubkey(quote.merchant_wallet, "merchant");
  if (merchant !== pubkey(registeredMerchant, "registered_merchant")) reject("merchant_mismatch");
  const treasury = pubkey(quote.treasury, "treasury");
  if (!quote.order_id || typeof quote.order_id !== "string" || Buffer.byteLength(quote.order_id) > 64) {
    reject("order_id_invalid");
  }
  const total = uint(quote.total_lamports, "total_lamports");
  if (total === 0n) reject("total_lamports_zero");
  const treasuryAmount = total * 100n / 10_000n;
  const creatorAmount = total * 1n / 10_000n;
  const merchantAmount = total - treasuryAmount - creatorAmount;
  for (const [value, expected, label] of [
    [quote.treasury_amount_lamports, treasuryAmount, "treasury_amount_lamports"],
    [quote.ip_creator_amount_lamports, creatorAmount, "ip_creator_amount_lamports"],
    [quote.merchant_amount_lamports, merchantAmount, "merchant_amount_lamports"],
  ] as const) {
    if (value !== undefined && uint(value, label) !== expected) reject(`${label}_mismatch`);
  }
  return {
    program_id: SOLANA_PROGRAM_ID,
    merchant_wallet: merchant,
    treasury,
    order_id: quote.order_id,
    totalLamports: total,
  };
}
