import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  SOLANA_PROGRAM_ID,
  validateSolanaPaymentQuote,
  validateSolanaPaymentQuoteTerms,
  type SolanaPaymentQuote,
} from "../src/solanaPayment.js";

const AGENT = Keypair.generate().publicKey.toBase58();
const MERCHANT = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const NOW = Date.parse("2026-08-05T00:00:00.000Z");

function quote(patch: Partial<SolanaPaymentQuote> = {}): SolanaPaymentQuote {
  const creatorEnabled = false;
  const merchantAmount = 1_000_000n;
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(merchantAmount);
  const paymentId = createHash("sha256")
    .update(Buffer.from("AiFinPay-solana-payment-v1"))
    .update(new PublicKey(AGENT).toBuffer())
    .update(new PublicKey(MERCHANT).toBuffer())
    .update(amount)
    .update(new PublicKey(TREASURY).toBuffer())
    .update(Buffer.from([0]))
    .update(Buffer.from("order-1"))
    .digest();
  const [receipt] = PublicKey.findProgramAddressSync(
    [Buffer.from("b2b-payment"), new PublicKey(AGENT).toBuffer(), paymentId],
    new PublicKey(SOLANA_PROGRAM_ID),
  );
  return {
    chain: "solana",
    program_id: SOLANA_PROGRAM_ID,
    instruction: "b2b_pay_with_split",
    agent_pubkey: AGENT,
    merchant_wallet: MERCHANT,
    treasury: TREASURY,
    ip_creator: TREASURY,
    merchant_amount_lamports: merchantAmount.toString(),
    treasury_fee_lamports: "10000",
    ip_creator_fee_lamports: "0",
    total_lamports: "1010000",
    payment_id: `0x${paymentId.toString("hex")}`,
    payment_receipt: receipt.toBase58(),
    creator_fee_enabled: creatorEnabled,
    order_id: "order-1",
    ...patch,
  };
}

describe("Solana payment target", () => {
  it("quarantines signing until the replay-safe v0.6 upgrade is verified", () => {
    expect(() => validateSolanaPaymentQuote(quote(), MERCHANT, AGENT, NOW)).toThrow(
      "route_disabled_pending_v0_6_upgrade",
    );
  });

  it("accepts canonical v0.6 metadata for audit tooling only", () => {
    expect(validateSolanaPaymentQuoteTerms(quote(), MERCHANT, AGENT, NOW)).toMatchObject({
      program_id: SOLANA_PROGRAM_ID,
      agent_pubkey: AGENT,
      merchant_wallet: MERCHANT,
      treasury: TREASURY,
      ip_creator: TREASURY,
      order_id: "order-1",
      merchantAmountLamports: 1_000_000n,
      totalLamports: 1_010_000n,
      creatorFeeEnabled: false,
    });
  });

  it.each([
    ["wrong chain", { chain: "polygon" }, "chain_mismatch"],
    ["unregistered program", { program_id: Keypair.generate().publicKey.toBase58() }, "program_not_registered"],
    ["legacy instruction", { instruction: "b2b_pay" }, "instruction_mismatch"],
    ["missing instruction", { instruction: undefined }, "instruction_mismatch"],
    ["wrong agent", { agent_pubkey: Keypair.generate().publicKey.toBase58() }, "agent_mismatch"],
    ["wrong merchant", { merchant_wallet: Keypair.generate().publicKey.toBase58() }, "merchant_mismatch"],
    ["wrong treasury fee", { treasury_fee_lamports: "9999" }, "treasury_fee_lamports_mismatch"],
    ["wrong creator fee", { ip_creator_fee_lamports: "1" }, "ip_creator_fee_lamports_mismatch"],
    ["wrong total", { total_lamports: "1009999" }, "total_lamports_mismatch"],
    ["wrong payment id", { payment_id: `0x${"00".repeat(32)}` }, "payment_id_mismatch"],
    ["wrong receipt", { payment_receipt: Keypair.generate().publicKey.toBase58() }, "payment_receipt_mismatch"],
    ["empty order", { order_id: "" }, "order_id_invalid"],
  ])("rejects %s", (_name, patch, reason) => {
    expect(() => validateSolanaPaymentQuoteTerms(quote(patch), MERCHANT, AGENT, NOW)).toThrow(reason);
  });

  it("expires the compiled evidence window", () => {
    expect(() =>
      validateSolanaPaymentQuoteTerms(
        quote(),
        MERCHANT,
        AGENT,
        Date.parse("2026-09-03T00:00:00.000Z"),
      ),
    ).toThrow("registry_entry_expired");
  });

  it("the candidate builder uses the v0.6 discriminator and receipt PDA", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('update("global:b2b_pay_with_split")');
    expect(source).not.toContain('update("global:b2b_pay")');
    for (const account of ["configPda", "vaultPda", "receiptPda"]) {
      expect(source).toContain(`{ pubkey: ${account}`);
    }
    expect(source).not.toContain("passportPda");
    expect(source).not.toContain("partnerPda");
  });
});
