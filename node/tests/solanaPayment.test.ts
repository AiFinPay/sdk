import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  SOLANA_PROGRAM_ID,
  validateSolanaPaymentQuote,
  validateSolanaPaymentQuoteTerms,
  type SolanaPaymentQuote,
} from "../src/solanaPayment.js";

const MERCHANT = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const NOW = Date.parse("2026-08-05T00:00:00.000Z");

function quote(patch: Partial<SolanaPaymentQuote> = {}): SolanaPaymentQuote {
  return {
    chain: "solana",
    program_id: SOLANA_PROGRAM_ID,
    instruction: "b2b_pay",
    merchant_wallet: MERCHANT,
    treasury: TREASURY,
    total_lamports: "100000",
    merchant_amount_lamports: "98990",
    treasury_amount_lamports: "1000",
    ip_creator_amount_lamports: "10",
    order_id: "order-1",
    ...patch,
  };
}

describe("Solana payment target", () => {
  it("quarantines signing until the replay-safe v0.6 upgrade is verified", () => {
    expect(() => validateSolanaPaymentQuote(quote(), MERCHANT, NOW)).toThrow(
      "route_disabled_pending_v0_6_upgrade",
    );
  });

  it("accepts canonical v0.5 metadata for audit tooling only", () => {
    expect(validateSolanaPaymentQuoteTerms(quote(), MERCHANT, NOW)).toMatchObject({
      program_id: SOLANA_PROGRAM_ID,
      merchant_wallet: MERCHANT,
      treasury: TREASURY,
      order_id: "order-1",
      totalLamports: 100000n,
    });
  });

  it.each([
    ["wrong chain", { chain: "polygon" }, "chain_mismatch"],
    ["unregistered program", { program_id: Keypair.generate().publicKey.toBase58() }, "program_not_registered"],
    ["invented instruction", { instruction: "b2b_pay_with_split" }, "instruction_mismatch"],
    ["missing instruction", { instruction: undefined }, "instruction_mismatch"],
    ["wrong merchant", { merchant_wallet: Keypair.generate().publicKey.toBase58() }, "merchant_mismatch"],
    ["missing total", { total_lamports: undefined }, "total_lamports_invalid"],
    ["wrong treasury fee", { treasury_amount_lamports: "999" }, "treasury_amount_lamports_mismatch"],
    ["wrong creator fee", { ip_creator_amount_lamports: "9" }, "ip_creator_amount_lamports_mismatch"],
    ["wrong merchant amount", { merchant_amount_lamports: "98989" }, "merchant_amount_lamports_mismatch"],
    ["empty order", { order_id: "" }, "order_id_invalid"],
  ])("rejects %s", (_name, patch, reason) => {
    expect(() => validateSolanaPaymentQuoteTerms(quote(patch), MERCHANT, NOW)).toThrow(reason);
  });

  it("expires the compiled evidence window", () => {
    expect(() =>
      validateSolanaPaymentQuoteTerms(
        quote(),
        MERCHANT,
        Date.parse("2026-09-03T00:00:00.000Z"),
      ),
    ).toThrow("registry_entry_expired");
  });

  it("the builder uses the deployed discriminator and all four PDAs", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8"),
    );
    expect(source).toContain('update("global:b2b_pay")');
    expect(source).not.toContain('update("global:b2b_pay_with_split")');
    for (const account of ["configPda", "passportPda", "partnerPda", "vaultPda"]) {
      expect(source).toContain(`{ pubkey: ${account}`);
    }
  });
});
